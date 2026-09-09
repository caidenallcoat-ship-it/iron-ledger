import { buildNudge, rankOf } from "./_lib.js";
import { bedHour, inBedOnTime } from "./health.js";

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

console.log("");
console.log("earned rest days");
const restToday = buildNudge(base(hist(20, 1, 3), { passes: { [TODAY]: "rest" } }), TODAY);
ok("a rest day with nothing else outstanding says nothing at all",
  restToday === null, JSON.stringify(restToday));

const restPlusJob = buildNudge(
  base(hist(20, 1, 3), {
    passes: { [TODAY]: "rest" },
    chores: [{ id: "b", name: "Bins", every: 7, last: "2026-08-01" }],
  }), TODAY);
ok("a rest day still names other work",
  restPlusJob && restPlusJob.body.startsWith("Rest day, earned.") && restPlusJob.body.length > 20,
  restPlusJob && restPlusJob.body);
ok("a rest day never mentions a session",
  !restPlusJob || !/Session [A-E]/.test(restPlusJob.body), restPlusJob && restPlusJob.body);

// Target 2, one real session on Tuesday, and Monday covered by a rest day:
// that is a met week, so there is nothing to say.
const oneSession = { "2026-09-08": { key: "A", at: "x", express: false } };
ok("a rest day lowers what the week asks for",
  buildNudge(base(oneSession, { target: 2, passes: { "2026-09-07": "rest" } }), TODAY) === null,
  JSON.stringify(buildNudge(base(oneSession, { target: 2, passes: { "2026-09-07": "rest" } }), TODAY)));
ok("without it the same week is still short",
  buildNudge(base(oneSession, { target: 2 }), TODAY) !== null);
ok("a rest day on a day you trained buys nothing",
  buildNudge(base(oneSession, { target: 2, passes: { "2026-09-08": "rest" } }), TODAY) !== null);

// The count itself must stay truthful: the rest day comes off the bar, it is
// never added to the sessions.
const metWithRest = buildNudge(
  base(oneSession, {
    target: 2,
    passes: { "2026-09-07": "rest" },
    chores: [{ id: "b", name: "Bins", every: 7, last: "2026-08-01" }],
  }), TODAY);
ok("a met week still reports the real session count",
  metWithRest && metWithRest.body.includes("1 of 2"), metWithRest && metWithRest.body);
ok("and says the rest day was earned rather than hiding it",
  metWithRest && metWithRest.body.includes("1 rest day earned"), metWithRest && metWithRest.body);
ok("a food pass does not silence training",
  /Session [A-E]/.test(buildNudge(base(hist(20, 1, 3), { passes: { [TODAY]: "food" } }), TODAY).body));

// A day can hold several bought effects. The app writes an array; records
// written before that hold a bare string. Both must behave identically here,
// or the phone starts nagging on a day that was paid for.
console.log("");
console.log("both stored shapes");
ok("an array-shaped rest day is still a rest day",
  buildNudge(base(hist(20, 1, 3), { passes: { [TODAY]: ["rest"] } }), TODAY) === null);
ok("a rest day alongside other effects still counts",
  buildNudge(base(hist(20, 1, 3), { passes: { [TODAY]: ["late", "rest", "food"] } }), TODAY) === null);
ok("an array without a rest day does not silence training",
  /Session [A-E]/.test(
    buildNudge(base(hist(20, 1, 3), { passes: { [TODAY]: ["food", "late"] } }), TODAY).body));
ok("an array-shaped rest day lowers the week the same way",
  buildNudge(base(oneSession, { target: 2, passes: { "2026-09-07": ["rest"] } }), TODAY) === null);
ok("an empty array is not a pass",
  /Session [A-E]/.test(buildNudge(base(hist(20, 1, 3), { passes: { [TODAY]: [] } }), TODAY).body));

console.log("");
console.log("an evening off the ledger");
const noisy = base(hist(20, 1, 3), {
  chores: [{ id: "b", name: "Bins", every: 7, last: "2026-08-01" }],
});
ok("that evening would normally say plenty", buildNudge(noisy, TODAY) !== null);
ok("bought quiet, it says nothing at all",
  buildNudge({ ...noisy, passes: { [TODAY]: ["quiet"] } }, TODAY) === null,
  JSON.stringify(buildNudge({ ...noisy, passes: { [TODAY]: ["quiet"] } }, TODAY)));
ok("quiet silences the jobs too, not just the session",
  buildNudge({ ...noisy, passes: { [TODAY]: ["quiet"] } }, TODAY) === null);
// Quiet is not a rest day: it buys silence, not the session.
const quietWeek = buildNudge(
  { ...base(oneSession, { target: 2, passes: { "2026-09-07": ["quiet"] } }) }, TODAY);
ok("a quiet evening does not lower what the week asks for", quietWeek !== null,
  JSON.stringify(quietWeek));

console.log("");
console.log("day one names the right time");
const { slotText } = await import("./_lib.js");
ok("a 17:30 slot reads as 17:30", slotText({ slot: 17.5 }) === "17:30");
ok("a 19:30 slot reads as 19:30", slotText({ slot: 19.5 }) === "19:30");
ok("no slot falls back rather than inventing one", slotText({}) === "18:30");
ok("nonsense falls back too", slotText({ slot: "half six" }) === "18:30");
// The only message that names a time, and it named the wrong one for anyone
// who had not chosen 18:30.
const dayOne = buildNudge(base({}, { start: TODAY, slot: 17.5 }), TODAY);
ok("day one uses the record's own time",
  dayOne.body.includes("from 17:30"), dayOne.body);
ok("and not the old hardcoded one", !dayOne.body.includes("18:30"), dayOne.body);

console.log("");
console.log("evenings already spoken for");
const busyNight = buildNudge(
  base(hist(20, 1, 3), { busy: { [TODAY]: "Mum's birthday" } }), TODAY);
ok("tonight's plans are named, not argued with",
  busyNight && busyNight.body.startsWith("Mum's birthday."), busyNight && busyNight.body);
ok("and it does not nag about a session that can't happen",
  busyNight && !/Session [A-E]/.test(busyNight.body), busyNight && busyNight.body);
ok("a busy evening with no label still works",
  buildNudge(base(hist(20, 1, 3), { busy: { [TODAY]: true } }), TODAY)
    .body.startsWith("You have something on."));

// The point of the whole thing: booked evenings shrink the room, never the target.
const twoSessions = {
  "2026-09-07": { key: "A", at: "x", express: false },
  "2026-09-08": { key: "B", at: "x", express: false },
};
const roomy = buildNudge(base(twoSessions, { target: 3 }), TODAY);
// Thursday to Sunday all booked, so tonight is the only evening left for the
// session still owed. Two free evenings for one session would not be at risk,
// and the app should not pretend otherwise.
const cramped = buildNudge(
  base(twoSessions, {
    target: 3,
    busy: { "2026-09-10": true, "2026-09-11": true, "2026-09-12": true, "2026-09-13": true },
  }),
  TODAY);
ok("with the week open it is an ordinary evening",
  roomy && !/Every one counts now/.test(roomy.body), roomy && roomy.body);
ok("with the rest of the week booked it goes to at-risk",
  cramped && /Every one counts now/.test(cramped.body), cramped && cramped.body);
ok("and it says how many evenings are actually left",
  cramped && /free evening/.test(cramped.body), cramped && cramped.body);
ok("the target itself never moves",
  cramped && cramped.body.includes("of 3"), cramped && cramped.body);
ok("an evening you already trained is not counted as free",
  buildNudge(base(twoSessions, { target: 3 }), TODAY).body.includes("2 of 3"));

console.log("");
console.log("health: reading a bedtime");
ok('"23:12" is 23.2', Math.abs(bedHour("23:12") - 23.2) < 0.01, String(bedHour("23:12")));
ok('"01:30" is 1.5', bedHour("01:30") === 1.5, String(bedHour("01:30")));
ok("a full timestamp is read as wall-clock",
  Math.abs(bedHour("2026-09-08T23:45:00Z") - 23.75) < 0.01, String(bedHour("2026-09-08T23:45:00Z")));
ok("a bare number passes through", bedHour(22.5) === 22.5);
ok("nonsense is null", bedHour("last night") === null && bedHour("") === null && bedHour(null) === null);
ok("an impossible hour is null", bedHour(99) === null && bedHour("47:00") === null);

console.log("");
console.log("health: was that on time");
// The whole trick: after midnight is LATER than an 11pm target, not earlier.
ok("22:30 beats an 11pm target", inBedOnTime(22.5, 23) === true);
ok("23:00 exactly meets it", inBedOnTime(23, 23) === true);
ok("23:30 misses it", inBedOnTime(23.5, 23) === false);
ok("00:30 misses it", inBedOnTime(0.5, 23) === false);
ok("01:30 misses it", inBedOnTime(1.5, 23) === false);
ok("02:00 misses a midnight target", inBedOnTime(2, 0) === false);
ok("23:00 beats a midnight target", inBedOnTime(23, 0) === true);
ok("00:30 beats a 1am target", inBedOnTime(0.5, 1) === true);
ok("an unreadable time stays unreadable", inBedOnTime(null, 23) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
