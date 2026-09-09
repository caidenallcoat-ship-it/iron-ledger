import { buildNudge, rankOf } from "./_lib.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "\n       " + extra : "")); }
};

const TODAY = "2026-09-09";
const day = (back) => {
  const d = new Date(Date.UTC(2026, 8, 9));
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
};
const hist = (n, endGap, every, express = false) => {
  const out = {};
  for (let i = 0; i < n; i++) out[day(endGap + i * every)] = { key: "A", at: "x", express };
  return out;
};
const base = (done, extra = {}) => ({
  done, skips: [], ticks: {}, target: 3, start: "2026-01-01",
  chores: [], weekly: {}, ...extra,
});

console.log("rankOf");
ok("nothing is Unproven", rankOf({}).name === "Unproven");
ok("4 is Started", rankOf(hist(4, 0, 30)).name === "Started");
ok("12 is Regular", rankOf(hist(12, 0, 30)).name === "Regular");
ok("24 is Established", rankOf(hist(24, 0, 30)).name === "Established");
ok("48 is Ingrained", rankOf(hist(48, 0, 30)).name === "Ingrained");
ok("96 is Permanent", rankOf(hist(96, 0, 30)).name === "Permanent");
const ex = rankOf(hist(20, 0, 30, true));
ok("short versions count half (20 -> 10)", ex.n === 10 && ex.name === "Started", JSON.stringify(ex));

console.log("\nback from a break");
const smallBreak = buildNudge(base(hist(5, 14, 3)), TODAY);
ok("low rank gets the plain restart line",
  smallBreak.body.includes("first one back") && !smallBreak.body.includes("banked"),
  smallBreak.body);
const bigBreak = buildNudge(base(hist(30, 14, 3)), TODAY);
ok("high rank is told what's at stake",
  bigBreak.body.includes("30 sessions banked") && bigBreak.body.includes("three months"),
  bigBreak.body);
ok("both still name the session", /Session [A-E]/.test(smallBreak.body) && /Session [A-E]/.test(bigBreak.body));

console.log("\nordinary evening");
const newbie = buildNudge(base(hist(3, 1, 3)), TODAY);
ok("no rank in the title before Regular", newbie.title === "Iron Ledger", newbie.title);
const veteran = buildNudge(base(hist(30, 1, 7)), TODAY);
ok("rank named in the title once earned",
  veteran.title === "Iron Ledger — Established", veteran.title);
ok("body still leads with the week", /^\d+ of 3 this week\./.test(veteran.body), veteran.body);

console.log("\nunchanged behaviour");
ok("no record at all still handled", buildNudge(null, TODAY).body.includes("No record found"));
ok("week met and nothing else owed stays silent",
  buildNudge(base(hist(3, 0, 1)), TODAY) === null);
ok("day one is untouched",
  buildNudge(base({}, { start: TODAY }), TODAY).body.includes("Day one"));
ok("never finished a session is untouched",
  buildNudge(base({}), TODAY).body.includes("never finished a session"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
