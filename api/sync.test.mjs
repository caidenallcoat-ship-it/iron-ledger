/**
 * The app and the Shortcuts both write the same record. The app sends its
 * whole copy; if that copy is older than something a Shortcut wrote in the
 * meantime, the Shortcut's write must survive.
 *
 * The scenario that motivated this: phone has the app open, the Watch logs a
 * session through /api/session, then a chore is ticked in the app — and the
 * app's save erased the session.
 */
process.env.LEDGER_KEY = "k";
process.env.KV_REST_API_URL = "http://example.invalid";
process.env.KV_REST_API_TOKEN = "fake";

const FIXED = new Date("2026-09-10T18:00:00Z").getTime();
const RealDate = Date;
let clock = FIXED;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [clock])); }
  static now() { return clock; }
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

const store = new Map(), hashes = new Map();
globalThis.fetch = async (_u, init) => {
  const cmd = JSON.parse(init.body); const [op, key, a, b] = cmd; let result = null;
  if (op === "GET") result = store.has(key) ? store.get(key) : null;
  else if (op === "SET") { store.set(key, a); result = "OK"; }
  else if (op === "DEL") { store.delete(key); hashes.delete(key); result = 1; }
  else if (op === "HSET") { if (!hashes.has(key)) hashes.set(key, new Map()); hashes.get(key).set(a, b); result = 1; }
  else if (op === "HGETALL") { const h = hashes.get(key); result = h ? [...h.entries()].flat() : []; }
  else result = 1;
  return { ok: true, json: async () => ({ result }) };
};

const U = await import("./_users.js");
const stateH = (await import("./state.js")).default;
const sessionH = (await import("./session.js")).default;
const uid = await U.userForKey("k");

const call = async (h, method, body) => {
  const res = { _s: 200, _j: null, setHeader() {}, status(s) { this._s = s; return this; }, json(j) { this._j = j; return this; } };
  await h({ method, headers: { "x-ledger-key": "k" }, body }, res);
  return { status: res._s, body: res._j };
};
const tick = (ms = 1000) => { clock += ms; };

const TODAY = "2026-09-10";
const base0 = { start: "2026-09-01", done: {}, ticks: {}, skips: [], target: 3, daily: {}, spend: {},
  chores: [{ id: "bin", name: "Bins", every: 7, last: null }], updatedAt: 1000 };
await U.saveFor(uid, JSON.parse(JSON.stringify(base0)));

console.log("the watch logs a session while the app is open");
// 1. the app pulls
let r = await call(stateH, "GET");
const appCopy = r.body;
const pulled1 = JSON.parse(JSON.stringify(r.body));
// 2. the watch logs tonight's session, straight to the server
tick(); r = await call(sessionH, "POST", {});
ok("the watch's session is on the server", r.status === 200 && Boolean((await U.loadFor(uid)).done[TODAY]));
// 3. the app, still holding its older copy, ticks the bins and saves
tick();
appCopy.chores[0].last = TODAY;
appCopy.updatedAt = Date.now();
r = await call(stateH, "PUT", { ...appCopy, _base: pulled1 });
const after = await U.loadFor(uid);
ok("the app's change landed", after.chores[0].last === TODAY, JSON.stringify(after.chores));
ok("AND the watch's session survived it", Boolean(after.done[TODAY]), JSON.stringify(after.done));

console.log("");
console.log("both sides touched the same day");
await U.saveFor(uid, { ...JSON.parse(JSON.stringify(base0)), updatedAt: 2000 });
r = await call(stateH, "GET"); const a2 = r.body; const pulled2 = JSON.parse(JSON.stringify(r.body));
// the server gets a sleep mark for today from Health
const srv = await U.loadFor(uid); srv.daily[TODAY] = { bed: true, bedVia: "health" }; tick(); await U.saveFor(uid, srv);
// the app ticks protein for today
tick(); a2.daily[TODAY] = { protein: true }; a2.updatedAt = Date.now();
await call(stateH, "PUT", { ...a2, _base: pulled2 });
const d2 = (await U.loadFor(uid)).daily[TODAY] || {};
ok("the app's protein tick landed", d2.protein === true, JSON.stringify(d2));
ok("and Health's sleep mark on the same day survived", d2.bed === true, JSON.stringify(d2));

console.log("");
console.log("deletes still work");
await U.saveFor(uid, { ...JSON.parse(JSON.stringify(base0)), done: { [TODAY]: { key: "A", at: "x" } }, updatedAt: 3000 });
r = await call(stateH, "GET"); const a3 = r.body; const pulled3 = JSON.parse(JSON.stringify(r.body));
// something unrelated changes on the server
const s3 = await U.loadFor(uid); s3.spend[TODAY] = 12; tick(); await U.saveFor(uid, s3);
// the app undoes tonight's session
tick(); delete a3.done[TODAY]; a3.updatedAt = Date.now();
await call(stateH, "PUT", { ...a3, _base: pulled3 });
const d3 = await U.loadFor(uid);
ok("an undo in the app is not resurrected by the merge", !d3.done[TODAY], JSON.stringify(d3.done));
ok("while the server's unrelated change is kept", d3.spend[TODAY] === 12, JSON.stringify(d3.spend));

console.log("");
console.log("an old app that doesn't send a base still works as before");
await U.saveFor(uid, { ...JSON.parse(JSON.stringify(base0)), updatedAt: 4000 });
r = await call(stateH, "PUT", { ...JSON.parse(JSON.stringify(base0)), target: 4, updatedAt: 5000 });
ok("plain PUT still saves", r.status === 200 && (await U.loadFor(uid)).target === 4);

console.log("");
console.log("the merge itself");
const { merge3 } = await import("./_merge.js");
// a Siri task and an app task added to the same week's list
const b4 = { weekly: { house: [{ id: "a", text: "Bins", done: false }] } };
const m4 = { weekly: { house: [{ id: "a", text: "Bins", done: true }, { id: "b", text: "Hoover" }] } };
const t4 = { weekly: { house: [{ id: "a", text: "Bins", done: false }, { id: "c", text: "Ring Mum", via: "api" }] } };
const r4 = merge3(b4, m4, t4).weekly.house;
ok("tasks added on both sides are both kept", r4.map((x) => x.id).join() === "a,b,c", JSON.stringify(r4));
ok("and the app ticking one off still counts", r4.find((x) => x.id === "a").done === true);
// a task deleted in the app and untouched on the server stays deleted
const r5 = merge3({ l: [{ id: "a" }, { id: "b" }] }, { l: [{ id: "a" }] }, { l: [{ id: "a" }, { id: "b" }] }).l;
ok("a task removed in the app stays removed", r5.length === 1 && r5[0].id === "a", JSON.stringify(r5));
// both changed the same plain value: the app wins, because it's the person's direct action
ok("a genuine clash goes to the app", merge3({ target: 3 }, { target: 4 }, { target: 2 }).target === 4);
// key order must not make two identical records look different
ok("key order doesn't count as a change",
  merge3({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }, { a: { x: 1, y: 2, z: 3 } }).a.z === 3);

globalThis.Date = RealDate;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
