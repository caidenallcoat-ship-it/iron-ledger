/**
 * /api/session — the endpoint that lets a watch, a Siri phrase or an
 * automation record training. Run against a faked store and a faked record,
 * so it needs neither Redis nor the network.
 */
process.env.LEDGER_KEY = "k";
process.env.KV_REST_API_URL = "http://example.invalid";
process.env.KV_REST_API_TOKEN = "fake";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

// A stand-in Redis covering the commands the users layer needs too.
const store = new Map();
const hashes = new Map();
globalThis.fetch = async (_url, init) => {
  const cmd = JSON.parse(init.body);
  const [op, key, a, b] = cmd;
  let result = null;
  if (op === "GET") result = store.has(key) ? store.get(key) : null;
  else if (op === "SET") { store.set(key, a); result = "OK"; }
  else if (op === "DEL") { store.delete(key); hashes.delete(key); result = 1; }
  else if (op === "HSET") {
    if (!hashes.has(key)) hashes.set(key, new Map());
    hashes.get(key).set(a, b); result = 1;
  } else if (op === "HDEL") {
    if (hashes.has(key)) for (const f of cmd.slice(2)) hashes.get(key).delete(f);
    result = 1;
  } else if (op === "HGETALL") {
    const h = hashes.get(key);
    result = h ? [...h.entries()].flat() : [];
  } else result = 1;
  return { ok: true, json: async () => ({ result }) };
};

let OWNER_UID = null;

const U = await import("./_users.js");
OWNER_UID = await U.userForKey("k");
const DOC = "iron-ledger:u:" + OWNER_UID;
/* Read and write the owner's record straight out of the fake store, so
   the assertions stay synchronous. */
const read = () => JSON.parse(store.get(DOC));
const seed = (rec) => store.set(DOC, JSON.stringify(rec));
const handler = (await import("./session.js")).default;

// Freeze "today" to a known Wednesday so the week maths is checkable.
const TODAY = "2026-09-09";
const { localParts } = await import("./_lib.js");
const realNow = Date.now;
Date.now = () => new Date("2026-09-09T12:00:00Z").getTime();

const call = async (method, body) => {
  const res = {
    _s: 200, _j: null, _h: {},
    setHeader(k, v) { this._h[k] = v; },
    status(s) { this._s = s; return this; },
    json(j) { this._j = j; return this; },
  };
  await handler({ method, headers: { "x-ledger-key": "k" }, body }, res);
  return { status: res._s, body: res._j };
};

const reset = (done = {}) => {
  if (!OWNER_UID) throw new Error('owner not resolved');
  seed({ start: "2026-09-07", done, skips: [], ticks: {}, target: 3, daily: {}, updatedAt: 1 });
};

console.log("logging a session from outside the app");
reset();
let r = await call("POST", {});
ok("a bare post logs today", r.status === 200 && r.body.ok === true, JSON.stringify(r));
ok("it picks the first session in the queue", r.body.session === "A", r.body.session);
ok("and reports the week", r.body.thisWeek === 1 && r.body.target === 3, JSON.stringify(r.body));
ok("the record actually changed", Boolean(read().done[TODAY]), JSON.stringify(read().done));
ok("it is marked as coming from the api", read().done[TODAY].via === "api");

console.log("");
console.log("the queue is the record's business, not the caller's");
reset({ "2026-09-07": { key: "A", at: "x", express: false } });
r = await call("POST", { key: "E", session: "E" });
ok("a caller cannot choose the session", r.body.session === "B", JSON.stringify(r.body));

console.log("");
console.log("guards");
reset({ [TODAY]: { key: "A", at: "x", express: false } });
r = await call("POST", {});
ok("the same day twice is refused, not silently overwritten", r.status === 409, JSON.stringify(r));
ok("and it says what is already there", r.body.session === "A");

reset();
r = await call("POST", { date: "2099-01-01" });
ok("a future date is refused", r.status === 400 && r.body.error === "date_in_the_future");

reset();
r = await call("POST", { express: true, note: "  knackered, short one  " });
ok("the short version is recorded as such", read().done[TODAY].express === true);
ok("a note is trimmed and kept", read().done[TODAY].note === "knackered, short one", read().done[TODAY].note);
r = await call("POST", { date: "2026-09-08" });
ok("backfilling an earlier day works", r.status === 200 && Boolean(read().done["2026-09-08"]));

console.log("");
console.log("undo");
reset({ [TODAY]: { key: "C", at: "x", express: false } });
r = await call("DELETE", {});
ok("delete removes it", r.status === 200 && !read().done[TODAY], JSON.stringify(r.body));
r = await call("DELETE", {});
ok("deleting nothing is a 404, not a crash", r.status === 404);

console.log("");
console.log("reading");
reset({ "2026-09-07": { key: "A", at: "x", express: false } });
r = await call("GET");
ok("GET says what is next without logging it", r.body.session === "B" && r.body.loggedToday === false);
ok("GET names the session", r.body.name === "Wind", r.body.name);
ok("GET does not change the record", Object.keys(read().done).length === 1);

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
