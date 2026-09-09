/**
 * The gate, tested against the thing that actually went wrong: ten bad keys
 * from one address used to lock out the person holding the RIGHT key for
 * fifteen minutes. On a home connection, or any shared NAT, that is the same
 * address — so a mistyped key on a phone could lock the phone out of its own
 * ledger.
 *
 * Run with the store and key faked, so it needs neither Redis nor the network.
 */
process.env.LEDGER_KEY = "correct-horse-battery-staple";
process.env.KV_REST_API_URL = "http://example.invalid";
process.env.KV_REST_API_TOKEN = "fake";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

// A tiny in-memory stand-in for the Redis the limiter counts in.
const store = new Map();
globalThis.fetch = async (_url, init) => {
  const cmd = JSON.parse(init.body);
  const [op, key] = cmd;
  let result = null;
  if (op === "GET") result = store.has(key) ? String(store.get(key)) : null;
  else if (op === "INCR") { store.set(key, (store.get(key) || 0) + 1); result = store.get(key); }
  else if (op === "DEL") { store.delete(key); result = 1; }
  else if (op === "EXPIRE") result = 1;
  return { ok: true, json: async () => ({ result }) };
};

const { authorise } = await import("./_lib.js");

const req = (key, ip = "1.2.3.4") => ({
  headers: { "x-ledger-key": key, "x-forwarded-for": ip },
});
const GOOD = "correct-horse-battery-staple";

console.log("the gate");
ok("a correct key is allowed", (await authorise(req(GOOD))).ok === true);
ok("a wrong key is refused with 401", (await authorise(req("nope"))).status === 401);
ok("no key at all is refused with 401", (await authorise(req(undefined))).status === 401);

// Burn the allowance from one address.
for (let i = 0; i < 12; i++) await authorise(req("nope"));
const lockedOut = await authorise(req("nope"));
ok("after ten bad keys that address gets 429", lockedOut.status === 429, JSON.stringify(lockedOut));

// The regression this exists for.
const rightKeyWhileLocked = await authorise(req(GOOD));
ok("the RIGHT key still works from that same address",
  rightKeyWhileLocked.ok === true, JSON.stringify(rightKeyWhileLocked));
ok("and succeeding clears the counter",
  store.get("iron-ledger:fail:1.2.3.4") === undefined);
ok("so the next wrong key starts over at 401",
  (await authorise(req("nope"))).status === 401);

// Guessing is still stopped, which is the point of having a limiter at all.
for (let i = 0; i < 12; i++) await authorise(req("nope", "9.9.9.9"));
ok("a guesser is still locked out", (await authorise(req("nope", "9.9.9.9"))).status === 429);
ok("and one address's lockout does not touch another",
  (await authorise(req("nope", "5.5.5.5"))).status === 401);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
