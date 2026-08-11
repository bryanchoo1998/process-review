/* ============================================================
   supabase-client.js
   Drop-in replacement for the browser-storage layer in
   review.html and admin.html.

   Both apps touch persistence through exactly three functions —
   sGet / sSet / sDel — so this is the only file that changes.

   HOW TO USE
   1. Add before the app's own <script> block:
        <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
        <script src="/supabase-client.js"></script>
   2. Fill in SUPABASE_URL and SUPABASE_ANON_KEY below.
   3. In review.html / admin.html, delete the block that starts
      `const mem = {};` through the end of `async function sDel`.

   The anon key is safe in client code — RLS is what protects the
   data. Never put the service_role key here.

   NAMING: the DB-level session functions are prefixed db* (dbLoadSession,
   dbSaveSession, dbCompleteSession) because the app pages define their own
   saveSession()/loadSession() wrappers in the same global scope — an
   unprefixed name here would be shadowed by the app's and cause infinite
   recursion through sSet.
   ============================================================ */

const SUPABASE_URL = 'https://wdhnwxgcwzdhrojgstrq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_WakYpcHFoBXs-pqVIODj4g_qMbhRs_M';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ------------------------------------------------------------
   Shape translation
   The apps speak in keys: 'proc:index', 'proc:<id>', 'sess:<id>'.
   Postgres speaks in normalised tables. These map between them.
   ------------------------------------------------------------ */

async function loadProcessIndex(){
  const { data, error } = await sb
    .from('process')
    .select('id, name, domain, updated_at, step(count)')
    .eq('archived', false)
    .order('name');
  if(error) throw error;
  return data.map(p => ({
    id: p.id,
    name: p.name,
    domain: p.domain || '',
    steps: p.step?.[0]?.count ?? 0,
    updated: p.updated_at,
    status: 'ready'
  }));
}

async function loadProcess(id){
  const { data, error } = await sb
    .from('process')
    .select(`
      id, name, domain, global_label, local_label, updated_at,
      step ( id, seq, step_no, name, office, agree, note,
             substep ( version, seq, ref, body ) )
    `)
    .eq('id', id)
    .single();
  if(error) throw error;

  const steps = (data.step || [])
    .sort((a,b) => a.seq - b.seq)
    .map(s => {
      const pick = v => (s.substep || [])
        .filter(x => x.version === v)
        .sort((a,b) => a.seq - b.seq)
        .map(x => ({ ref: x.ref, text: x.body }));
      return {
        _id: s.id,                       // real PK, needed when writing responses
        id: s.step_no, name: s.name, office: s.office,
        agree: s.agree, note: s.note || '',
        global: pick('global'), local: pick('local')
      };
    });

  return {
    id: data.id, name: data.name, domain: data.domain || '',
    globalLabel: data.global_label, localLabel: data.local_label,
    updated: data.updated_at, steps
  };
}

async function saveProcess(p){
  const { data, error } = await sb.from('process').upsert({
    id: p.id, name: p.name, domain: p.domain,
    global_label: p.globalLabel, local_label: p.localLabel
  }).select('id').single();
  if(error) throw error;
  const pid = data.id;

  // Replace steps wholesale. Simpler and safer than diffing, and the
  // cascade clears substeps. Session answers reference step ids, so
  // only do this while a process is still in draft.
  await sb.from('step').delete().eq('process_id', pid);

  for(const [i, s] of p.steps.entries()){
    const { data: st, error: e2 } = await sb.from('step').insert({
      process_id: pid, seq: i + 1, step_no: s.id, name: s.name,
      office: s.office, agree: !!s.agree, note: s.note || null
    }).select('id').single();
    if(e2) throw e2;

    const subs = [];
    ['global','local'].forEach(v =>
      (s[v] || []).forEach((d, j) =>
        subs.push({ step_id: st.id, version: v, seq: j + 1, ref: d.ref, body: d.text })));
    if(subs.length){
      const { error: e3 } = await sb.from('substep').insert(subs);
      if(e3) throw e3;
    }
  }
  return pid;
}

/* ------------------------------------------------------------
   Sessions
   ------------------------------------------------------------ */

async function dbLoadSession(processId){
  const { data: { user } } = await sb.auth.getUser();
  // Pilot: anon visitors have no uid, so there is no per-user session
  // to resume — each run starts fresh and saves under created_by = null.
  if(!user) return { responses:{}, assign:{}, visited:{} };

  const { data: sess } = await sb
    .from('session')
    .select(`id, region_code, status, started_at,
             session_card_assignment ( step_id, a_version ),
             response ( step_id, answer, note,
                        response_pick ( seq, source, custom_body,
                                        substep ( ref, version ) ) )`)
    .eq('process_id', processId)
    .eq('created_by', user?.id)
    .eq('status', 'in_progress')
    .maybeSingle();

  if(!sess) return { responses:{}, assign:{}, visited:{} };

  const t = translateSession(sess, await stepsFor(sess.process_id));
  return { id: sess.id, region: sess.region_code, responses: t.responses, assign: t.assign, visited:{} };
}

// Resolve a stored session back into the app's blind A/B shape.
async function stepsFor(processId){
  const { data } = await sb.from('step').select('id, step_no').eq('process_id', processId);
  return data || [];
}

function translateSession(sess, steps){
  // step_id -> step_no, since the app keys everything by step_no
  const noOf = Object.fromEntries((steps||[]).map(s => [s.id, s.step_no]));

  const assign = {};
  (sess.session_card_assignment||[]).forEach(a => { assign[noOf[a.step_id]] = a.a_version; });

  const responses = {};
  (sess.response||[]).forEach(r => {
    const key = noOf[r.step_id];
    const rec = { val: r.answer, note: r.note || '' };
    const picks = (r.response_pick||[]).sort((a,b)=>a.seq-b.seq);
    if(picks.length){
      rec.picks = []; rec.customs = {};
      picks.forEach(p => {
        if(p.source === 'custom'){
          const id = 'c' + p.seq;
          rec.customs[id] = p.custom_body;
          rec.picks.push('c:' + id);
        } else if(p.substep){
          // resolve back to the blind A/B label the reviewer saw
          const side = (assign[key] === p.substep.version) ? 'a' : 'b';
          rec.picks.push(side + ':' + p.substep.ref);
        }
      });
    }
    responses[key] = rec;
  });

  return { responses, assign };
}

async function dbSaveSession(processId, S){
  let sessionId = S.id;

  if(!sessionId){
    const { data, error } = await sb.from('session').insert({
      process_id: processId, region_code: S.region, participants: S.name
    }).select('id').single();
    if(error) throw error;
    sessionId = S.id = data.id;
  }

  const { data: steps } = await sb.from('step')
    .select('id, step_no').eq('process_id', processId);
  const idOf = Object.fromEntries((steps||[]).map(s => [s.step_no, s.id]));

  // card assignments — write once, never update; they must stay locked
  const assigns = Object.entries(S.assign||{})
    .filter(([no]) => idOf[no])
    .map(([no, v]) => ({ session_id: sessionId, step_id: idOf[no], a_version: v }));
  if(assigns.length){
    await sb.from('session_card_assignment')
      .upsert(assigns, { onConflict: 'session_id,step_id', ignoreDuplicates: true });
  }

  for(const [stepNo, r] of Object.entries(S.responses||{})){
    if(!r.val || !idOf[stepNo]) continue;
    const { data: resp, error } = await sb.from('response').upsert({
      session_id: sessionId, step_id: idOf[stepNo],
      answer: r.val, note: r.note || null
    }, { onConflict: 'session_id,step_id' }).select('id').single();
    if(error) throw error;

    if(r.picks?.length){
      await sb.from('response_pick').delete().eq('response_id', resp.id);
      const aIs = S.assign[stepNo];
      const { data: subs } = await sb.from('substep')
        .select('id, version, ref').eq('step_id', idOf[stepNo]);

      const rows = r.picks.map((k, i) => {
        const [side, ref] = k.split(':');
        if(side === 'c'){
          return { response_id: resp.id, seq: i+1, source: 'custom',
                   custom_body: r.customs?.[ref] || '' };
        }
        const version = (side === 'a') ? aIs : (aIs === 'global' ? 'local' : 'global');
        const hit = (subs||[]).find(x => x.version === version && x.ref === ref);
        return hit ? { response_id: resp.id, seq: i+1, source: version, substep_id: hit.id } : null;
      }).filter(Boolean);

      if(rows.length) await sb.from('response_pick').insert(rows);
    }
  }
}

async function dbCompleteSession(sessionId){
  await sb.from('session')
    .update({ status: 'complete', completed_at: new Date().toISOString() })
    .eq('id', sessionId);
}

// Admin records management — load any session by id (not just the
// current user's in-progress one), list sessions, delete one.
async function dbLoadSessionById(sessionId){
  const { data: sess, error } = await sb.from('session')
    .select(`id, process_id, region_code, participants, status, started_at, completed_at,
             session_card_assignment ( step_id, a_version ),
             response ( step_id, answer, note,
                        response_pick ( seq, source, custom_body, substep ( ref, version ) ) )`)
    .eq('id', sessionId)
    .maybeSingle();
  if(error) throw error;
  if(!sess) return null;

  const t = translateSession(sess, await stepsFor(sess.process_id));
  return { id: sess.id, process_id: sess.process_id, region: sess.region_code,
           name: sess.participants || '', status: sess.status,
           started_at: sess.started_at, completed_at: sess.completed_at,
           responses: t.responses, assign: t.assign, visited:{} };
}

async function dbListSessions(processId){
  let q = sb.from('session')
    .select(`id, process_id, region_code, participants, status, started_at, completed_at,
             process ( name ), response ( count )`);
  if(processId) q = q.eq('process_id', processId);
  const { data, error } = await q.order('started_at', { ascending: false });
  if(error) throw error;
  return (data||[]).map(s => ({
    id: s.id, process_id: s.process_id, process: s.process?.name || '',
    region: s.region_code, name: s.participants || '', status: s.status,
    started_at: s.started_at, completed_at: s.completed_at,
    answered: s.response?.[0]?.count ?? 0
  }));
}

async function dbDeleteSession(sessionId){
  // cascades to session_card_assignment / response / response_pick
  const { error } = await sb.from('session').delete().eq('id', sessionId);
  if(error) throw error;
}

/* ------------------------------------------------------------
   Analysis (admin dashboard)
   ------------------------------------------------------------ */

// Raw view data for one process: the step×session grid (each row is
// one step answered in one session), plus the two register lists.
// The dashboard UI aggregates the grid into one cell per region —
// the latest complete session wins, so a half-finished run never
// skews the matrix.
async function loadAnalysis(processId){
  const { data: grid, error: e1 } = await sb
    .from('v_step_region_grid')
    .select('step_id, step_no, step_name, seq, global_office, session_id, region_code, session_status, started_at, verdict, note, unanswered')
    .eq('process_id', processId)
    .order('seq').order('region_code');
  if(e1) throw e1;

  const { data: dropoff, error: e2 } = await sb
    .from('v_control_dropoff')
    .select('step_no, step_name, ref, body, regions_skipping, regions')
    .eq('process_id', processId);
  if(e2) throw e2;

  const { data: emergent, error: e3 } = await sb
    .from('v_emergent_register')
    .select('step_no, step_name, region_code, submitted_by, custom_body, position_in_sequence')
    .eq('process_id', processId);
  if(e3) throw e3;

  // sessions for submitter names on the matrix cells
  const { data: sessions, error: e4 } = await sb.from('session')
    .select('id, region_code, participants, status, started_at')
    .eq('process_id', processId);
  if(e4) throw e4;

  // responses + picks for those sessions — the drilldown shows the full
  // final sequence a region built, with extra (custom) steps marked
  const sessIds = (sessions||[]).map(s => s.id);
  let responses = [];
  if(sessIds.length){
    const { data: rp, error: e5 } = await sb.from('response')
      .select('session_id, step_id, answer, note, response_pick ( seq, source, custom_body, substep ( ref, version, body ) )')
      .in('session_id', sessIds);
    if(e5) throw e5;
    responses = rp || [];
  }

  // card assignments (which document was card A per session×step) — lets
  // the drilldown name the version a plain A/B answer follows
  let assignments = [];
  if(sessIds.length){
    const { data: asg, error: e6 } = await sb.from('session_card_assignment')
      .select('session_id, step_id, a_version').in('session_id', sessIds);
    if(e6) throw e6;
    assignments = asg || [];
  }

  return { grid: grid || [], dropoff: dropoff || [], emergent: emergent || [],
           sessions: sessions || [], responses, assignments };
}

// Processes for the dashboard picker, plus which ones have sessions.
async function loadAnalysisIndex(){
  const { data: processes, error: e1 } = await sb
    .from('process')
    .select('id, name, domain')
    .eq('archived', false)
    .order('name');
  if(e1) throw e1;

  const { data: sessions, error: e2 } = await sb
    .from('session')
    .select('process_id')
    .in('status', ['complete','in_progress']);
  if(e2) throw e2;

  const withSessions = new Set((sessions || []).map(s => s.process_id));
  return { processes: processes || [], withSessions };
}

/* ------------------------------------------------------------
   The three functions the apps actually call
   ------------------------------------------------------------ */
let _procIdCache = null;

async function sGet(key, fallback){
  try{
    if(key === 'proc:index') return await loadProcessIndex();
    if(key.startsWith('proc:')) return await loadProcess(key.slice(5));
    if(key.startsWith('sess:')) return await dbLoadSession(key.slice(5));
    return fallback;
  }catch(e){
    console.error('sGet', key, e);
    return fallback;
  }
}

async function sSet(key, val){
  // Errors propagate to the caller on purpose — the apps surface a
  // visible "not saved" hint when a write fails, instead of silently
  // pretending everything persisted.
  if(key === 'proc:index') return;                   // derived, nothing to write
  if(key.startsWith('proc:')) return await saveProcess(val);
  if(key.startsWith('sess:')) return await dbSaveSession(key.slice(5), val);
}

async function sDel(key){
  try{
    if(key.startsWith('proc:')){
      await sb.from('process').update({ archived: true }).eq('id', key.slice(5));
    }
    if(key.startsWith('sess:')){
      await sb.from('session').update({ status: 'abandoned' })
        .eq('process_id', key.slice(5)).eq('status', 'in_progress');
    }
  }catch(e){ console.error('sDel', key, e); }
}
