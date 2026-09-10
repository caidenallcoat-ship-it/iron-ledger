/**
 * Three-way merge of a ledger record.
 *
 *   base    — the version the app last synced with
 *   mine    — what the app is sending now
 *   theirs  — what the server has now (a Shortcut may have written since)
 *
 * The app used to send its whole copy and the server replaced what it had.
 * That was fine while the app was the only writer. Once the Watch could log a
 * session, Health could write sleep and Siri could log spending — all
 * straight to the server — any tap in an app holding an older copy erased
 * whatever had been written in between. Silently: nothing failed, the data
 * just wasn't there any more.
 *
 * The rule, applied all the way down:
 *   - the app didn't change it since base  -> keep the server's value
 *   - the server didn't change it          -> keep the app's value
 *   - both changed it: objects are merged key by key, lists of things with
 *     an id are merged by id, and anything else goes to the app, because
 *     that is the person's direct action.
 *
 * Deletions are honoured the same way: removed in the app and untouched on
 * the server means removed, so an undo is never resurrected by a merge.
 */

/** JSON with sorted keys, so two copies of the same record compare equal
    regardless of the order their keys were written in. */
export function canon(v) {
  if (v === undefined) return "u";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
}
const eq = (a, b) => canon(a) === canon(b);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isIdList = (v) => Array.isArray(v) && v.length > 0
  && v.every((x) => isObj(x) && x.id !== undefined && x.id !== null);

function mergeIdLists(b, m, t, depth) {
  const byId = (list) => new Map((list || []).map((x) => [String(x.id), x]));
  const B = byId(b), M = byId(m), T = byId(t);
  const order = [];
  for (const x of m || []) order.push(String(x.id));
  for (const x of t || []) if (!order.includes(String(x.id))) order.push(String(x.id));
  const out = [];
  for (const id of order) {
    const r = mergeValue(B.get(id), M.get(id), T.get(id), depth + 1);
    if (r !== undefined) out.push(r);
  }
  return out;
}

function mergeValue(b, m, t, depth) {
  if (eq(m, b)) return t;
  if (eq(t, b)) return m;
  if (depth < 6) {
    if (isObj(m) && isObj(t)) return mergeObjects(isObj(b) ? b : {}, m, t, depth + 1);
    if ((isIdList(m) || (Array.isArray(m) && !m.length)) && (isIdList(t) || (Array.isArray(t) && !t.length))
        && (m.length || t.length)) {
      return mergeIdLists(Array.isArray(b) ? b : [], m, t, depth);
    }
  }
  return m;
}

function mergeObjects(b, m, t, depth) {
  const out = {};
  const keys = new Set([...Object.keys(b || {}), ...Object.keys(m || {}), ...Object.keys(t || {})]);
  for (const k of keys) {
    const r = mergeValue(b ? b[k] : undefined, m ? m[k] : undefined, t ? t[k] : undefined, depth);
    if (r !== undefined) out[k] = r;
  }
  return out;
}

/** The merged record. updatedAt is left to the caller to stamp. */
export function merge3(base, mine, theirs) {
  if (!isObj(theirs)) return mine;
  if (!isObj(base)) return mine;            // nothing to merge against: the old behaviour
  const b = { ...base }, m = { ...mine }, t = { ...theirs };
  delete b.updatedAt; delete m.updatedAt; delete t.updatedAt;
  return mergeObjects(b, m, t, 0);
}
