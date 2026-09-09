/**
 * Two people on one ledger.
 *
 * The thing that must never break: the record that already existed belongs to
 * the owner afterwards, unchanged. Everything else here is about people not
 * being able to reach each other's data.
 */
process.env.LEDGER_KEY = "owner-key-aaaaaaaaaaaaaaaaaaaa";
process.env.KV_REST_API_URL = "http://example.invalid";
process.env.KV_REST_API_TOKEN = "fake";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

// A stand-in Redis with the handful of commands the code uses.
const store = new Map();
const hashes = new Map();
globalThis.fetch = async (_url, init) => {
  const cmd = JSON.parse(init.body);
  const [op, key, a, b] = cmd;
  let result = null;
  if (op === "GET") result = store.has(key) ? store.get(key) : null;
  else if (op === "SET") { store.set(key, a); result = "OK"; }
  else if (op === "DEL") { store.delete(key); hashes.delete(key); result = 1; }
  else if (op === "INCR") { store.set(key, String((Number(store.get(key)) || 0) + 1)); result = Number(store.get(key)); }
  else if (op === "EXPIRE") result = 1;
  else if (op === "HSET") {
    if (!hashes.has(key)) hashes.set(key, new Map());
    hashes.get(key).set(a, b); result = 1;
  } else if (op === "HDEL") {
    if (hashes.has(key)) for (const f of cmd.slice(2)) hashes.get(key).delete(f);
    result = 1;
  } else if (op === "HGETALL") {
    const h = hashes.get(key);
    result = h ? [...h.entries()].flat() : [];
  }
  return { ok: true, json: async () => ({ result }) };
};

const U = await import("./_users.js");
const { authorise } = await import("./_lib.js");
const peopleHandler = (await import("./people.js")).default;
const sessionHandler = (await import("./session.js")).default;

const OWNER = process.env.LEDGER_KEY;
const req = (key, method = "GET", body = undefined) => ({
  method, headers: { "x-ledger-key": key, "x-forwarded-for": "1.1.1.1" }, body,
});
const call = async (handler, key, method, body) => {
  const res = { _s: 200, _j: null, setHeader() {}, status(s) { this._s = s; return this; },
    json(j) { this._j = j; return this; } };
  await handler(req(key, method, body), res);
  return { status: res._s, body: res._j };
};

// The record as it exists today, before anyone has heard of users.
const EXISTING = {
  start: "2026-09-07", done: { "2026-09-08": { key: "A", at: "x", express: false } },
  chores: [{ id: "c1", name: "Washing", every: 3, last: "2026-09-06" }],
  target: 3, slot: 19.5, goal: "lean", skips: [], ticks: {}, daily: {}, updatedAt: 1,
};
store.set("iron-ledger:state", JSON.stringify(EXISTING));
hashes.set("iron-ledger:subs", new Map([["dev1", JSON.stringify({ endpoint: "https://x/1" })]]));

console.log("the record that already existed");
const uid = await U.userForKey(OWNER);
ok("the owner's key resolves to a person", Boolean(uid), String(uid));
const migrated = await U.loadFor(uid);
ok("their record came with them",
  JSON.stringify(migrated) === JSON.stringify(EXISTING), JSON.stringify(migrated));
ok("nothing was lost from it",
  migrated.chores.length === 1 && migrated.slot === 19.5 && Object.keys(migrated.done).length === 1);
ok("their registered device came too",
  hashes.get("iron-ledger:subs:" + uid) && hashes.get("iron-ledger:subs:" + uid).size === 1);
ok("the old key is left where it was, for a rollback",
  store.get("iron-ledger:state") !== undefined);
ok("resolving twice does not make a second person",
  (await U.userForKey(OWNER)) === uid);
ok("they are the owner", (await U.userInfo(uid)).admin === true);

console.log("");
console.log("adding your mate");
let r = await call(peopleHandler, OWNER, "POST", { name: "Dave" });
ok("the owner can add someone", r.status === 200 && Boolean(r.body.key), JSON.stringify(r.body));
const DAVE = r.body.key, DAVE_UID = r.body.uid;
ok("the key is long enough to be a key", DAVE.length >= 32, String(DAVE.length));
ok("the key itself is never stored",
  ![...store.values()].some((v) => typeof v === "string" && v.includes(DAVE)));
ok("a duplicate name is refused",
  (await call(peopleHandler, OWNER, "POST", { name: "dave" })).status === 409);
ok("a nameless person is refused",
  (await call(peopleHandler, OWNER, "POST", { name: "  " })).status === 400);

console.log("");
console.log("they cannot reach each other");
ok("Dave's key works", (await U.userForKey(DAVE)) === DAVE_UID);
ok("but starts with no record", (await U.loadFor(DAVE_UID)) === null);
await U.saveFor(DAVE_UID, { start: "2026-09-09", done: {}, target: 2, slot: 18.5 });
ok("the owner's record is untouched by Dave saving",
  (await U.loadFor(uid)).target === 3, JSON.stringify(await U.loadFor(uid)));
ok("and Dave's is his own", (await U.loadFor(DAVE_UID)).target === 2);
r = await call(sessionHandler, DAVE, "POST", {});
ok("Dave logging a session touches only his record", r.status === 200 && r.body.thisWeek === 1);
ok("the owner still has the one session they had",
  Object.keys((await U.loadFor(uid)).done).length === 1);
ok("Dave cannot add people", (await call(peopleHandler, DAVE, "POST", { name: "X" })).status === 403);
ok("Dave cannot remove people",
  (await call(peopleHandler, DAVE, "DELETE", { uid })).status === 403);
ok("a made-up key gets nowhere", (await U.userForKey("not-a-real-key")) === null);
ok("and is refused at the gate", (await authorise(req("not-a-real-key"))).status === 401);

console.log("");
console.log("what everyone can see");
r = await call(peopleHandler, DAVE, "GET");
ok("everyone sees who is on the ledger", r.status === 200 && r.body.people.length === 2);
const dave = r.body.people.find((p) => p.name === "Dave");
ok("and each other's week", dave.trained === 1 && dave.target === 2, JSON.stringify(dave));
ok("marked so you can tell which is you", dave.you === true);
const keysLeaked = JSON.stringify(r.body).includes(DAVE) || JSON.stringify(r.body).includes(OWNER);
ok("but no keys are handed out", !keysLeaked);
const shapeLeaked = /weight|spend|chores|passes|claims/.test(JSON.stringify(r.body));
ok("and nothing but the week is shared", !shapeLeaked, JSON.stringify(r.body).slice(0, 200));

console.log("");
console.log("removing someone");
ok("the owner cannot be deleted", (await U.removeUser(uid)) === false);
ok("the owner cannot delete themselves",
  (await call(peopleHandler, OWNER, "DELETE", { uid })).status === 400);
ok("Dave can be removed", (await call(peopleHandler, OWNER, "DELETE", { uid: DAVE_UID })).status === 200);
ok("and his record goes with him", (await U.loadFor(DAVE_UID)) === null);
ok("and his key stops working", (await authorise(req(DAVE))).status === 401);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
