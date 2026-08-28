/* Coach Simulator: in-memory Supabase mock. Loaded INSTEAD of
   vendor/supabase.js on simulator.html only. Guarantees total isolation:
   every read/write hits these in-memory tables, and window.fetch is
   disabled, so the production Coach Engine code runs untouched while
   nothing can reach the real backend. */
window.__simWrites = [];
window.__simTables = {};
window.__SIM__ = true;

function __simBuilder(table) {
  const st = { table, op: 'select', payload: null, filters: [], single: false, maybe: false };
  const api = {
    select() { return api; },
    insert(rows) { st.op = 'insert'; st.payload = rows; return api; },
    upsert(rows, opts) { st.op = 'upsert'; st.payload = rows; st.opts = opts || {}; return api; },
    update(vals) { st.op = 'update'; st.payload = vals; return api; },
    delete() { st.op = 'delete'; return api; },
    eq(col, val) { st.filters.push((r) => r[col] === val); return api; },
    gte(col, val) { st.filters.push((r) => r[col] >= val); return api; },
    in(col, vals) { st.filters.push((r) => vals.includes(r[col])); return api; },
    order() { return api; },
    range() { return api; },
    maybeSingle() { st.maybe = true; return api; },
    single() { st.single = true; return api; },
    then(resolve) { resolve(__simExec(st)); },
  };
  return api;
}

function __simExec(st) {
  const T = (window.__simTables[st.table] ||= []);
  if (st.op === 'insert' || st.op === 'upsert') {
    const defaults = st.table === 'ff_coach_recs'
      ? { decision: 'pending', outcome_status: 'pending', situation: {} } : {};
    const rows = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((r) => ({
      id: 'sim-' + Math.random().toString(36).slice(2),
      created_at: new Date().toISOString(), ...defaults, ...r,
    }));
    if (st.table === 'ff_coach_recs' && st.op === 'insert') {
      for (const r of rows) {
        if (T.some((x) => x.team_id === r.team_id && x.week === r.week && x.dedupe_key === r.dedupe_key)) {
          return { data: null, error: { code: '23505', message: 'duplicate key (sim)' } };
        }
      }
    }
    T.push(...rows);
    window.__simWrites.push({ table: st.table, op: st.op, rows });
    return { data: st.single ? rows[0] : rows, error: null };
  }
  let rows = T.filter((r) => st.filters.every((f) => f(r)));
  if (st.op === 'update') {
    rows.forEach((r) => Object.assign(r, st.payload));
    window.__simWrites.push({ table: st.table, op: 'update', rows });
    return { data: rows, error: null };
  }
  if (st.op === 'delete') {
    window.__simTables[st.table] = T.filter((r) => !rows.includes(r));
    window.__simWrites.push({ table: st.table, op: 'delete', rows });
    return { data: null, error: null };
  }
  if (st.single || st.maybe) {
    return { data: rows[0] || null, error: st.single && !rows[0] ? { message: 'no rows (sim)' } : null };
  }
  return { data: rows, error: null };
}

window.supabase = { createClient: () => ({ from: __simBuilder }) };
// no network of any kind escapes the simulator
window.fetch = () => Promise.reject(new Error('network disabled in Coach Simulator'));
