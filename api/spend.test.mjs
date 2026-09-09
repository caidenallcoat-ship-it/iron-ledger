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
const handler = (await import("./spend.js")).default;
const { readAmount } = await import("./spend.js");
Date.now = () => new Date("2026-09-09T12:00:00Z").getTime();
const TODAY = "2026-09-09";

const call = async (method, body) => {
  const res = { _s: 200, _j: null, setHeader() {}, status(s) { this._s = s; return this; },
    json(j) { this._j = j; return this; } };
  await handler({ method, headers: { "x-ledger-key": "k" }, body }, res);
  return { status: res._s, body: res._j };
};
const reset = (extra = {}) => {
  if (!OWNER_UID) throw new Error('owner not resolved');
  seed({ start: "2026-09-07", done: {}, skips: [], ticks: {}, target: 3, daily: {},
    spend: {}, areas: { money: { cap: 100 } }, updatedAt: 1, ...extra });
};

console.log("reading an amount");
ok("a plain number", readAmount(12.5) === 12.5);
ok("a string with a pound sign", readAmount("£12.50") === 12.5);
ok("commas and spaces", readAmount(" 1,200 ") === 1200);
ok("rounded to the penny", readAmount(3.333) === 3.33);
ok("nonsense is null", readAmount("a fiver") === null && readAmount("") === null);
ok("something absurd is null", readAmount(1e9) === null);

console.log("");
console.log("adding and replacing");
reset();
let r = await call("POST", { amount: 12.5 });
ok("adds to an empty day", r.body.now === 12.5 && read().spend[TODAY] === 12.5);
r = await call("POST", { amount: "£7.50" });
ok("adds again rather than replacing", r.body.now === 20 && r.body.was === 12.5);
r = await call("POST", { set: 5 });
ok("set replaces the day", r.body.now === 5 && read().spend[TODAY] === 5);
r = await call("POST", { amount: -5 });
ok("a refund can bring it down", r.body.now === 0);
ok("and a zero day is dropped, not stored", read().spend[TODAY] === undefined);
r = await call("POST", { amount: -5 });
ok("it cannot go negative", r.status === 400 && r.body.error === "negative_total", JSON.stringify(r.body));

console.log("");
console.log("the week, and the cap");
reset({ spend: { "2026-09-07": 30, "2026-09-08": 20 } });
r = await call("GET");
ok("counts the week", r.body.counted === 50 && r.body.total === 50);
ok("and what is left", r.body.left === 50 && r.body.over === false);

// An earned off-budget day leaves the cap alone but stays in the total.
reset({ spend: { "2026-09-07": 30, [TODAY]: 85 }, passes: { [TODAY]: ["spend"] } });
r = await call("GET");
ok("an off-budget day is out of the counted figure", r.body.counted === 30, JSON.stringify(r.body));
ok("but still in the total", r.body.total === 115, JSON.stringify(r.body));
ok("and named separately", r.body.excused === 85);
ok("so the cap is not blown by it", r.body.over === false && r.body.left === 70);
ok("the legacy string pass shape works too",
  (reset({ spend: { [TODAY]: 85 }, passes: { [TODAY]: "spend" } }),
   (await call("GET")).body.excused === 85));

console.log("");
console.log("guards");
reset();
ok("a future date is refused", (await call("POST", { amount: 5, date: "2099-01-01" })).status === 400);
ok("gibberish is refused", (await call("POST", { amount: "a fiver" })).status === 400);
ok("nothing at all is refused", (await call("POST", {})).status === 400);
ok("backfilling yesterday works",
  (await call("POST", { amount: 9, date: "2026-09-08" })).status === 200 && read().spend["2026-09-08"] === 9);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
