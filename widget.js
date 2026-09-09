/**
 * Iron Ledger — a home-screen widget for Scriptable (iOS, free on the App Store).
 *
 * Shortcuts cannot draw a widget; Scriptable can, and the ledger already
 * returns everything one needs. Shows the week, how many evenings are actually
 * left, what is next, and whatever is most overdue.
 *
 * Setup, once:
 *   1. Install Scriptable
 *   2. New script, paste this in, name it "Iron Ledger"
 *   3. Put your key in KEY below
 *   4. Home screen -> add a Scriptable widget -> Script: Iron Ledger
 *
 * The key sits in the script, so it is only as private as your phone. That is
 * the same trade as the Shortcuts, and the same key.
 */

const KEY = "PUT-YOUR-LEDGER-KEY-HERE";
const BASE = "https://iron-ledger-cade10.vercel.app";

const INK = new Color("#E9E7E2");
const MUTED = new Color("#8A8F8C");
const GROUND = new Color("#121416");
const WARN = new Color("#DFA245");
const DONE = new Color("#4FAD77");
const MISS = new Color("#E2604F");

async function get(path) {
  const r = new Request(BASE + path);
  r.headers = { "x-ledger-key": KEY };
  r.timeoutInterval = 10;
  return await r.loadJSON();
}

function line(stack, text, color, size, bold) {
  const t = stack.addText(text);
  t.textColor = color;
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.lineLimit = 1;
  return t;
}

const w = new ListWidget();
w.backgroundColor = GROUND;
w.setPadding(14, 14, 14, 14);

try {
  const [session, plan] = await Promise.all([get("/api/session"), get("/api/plan")]);

  const owed = Math.max(0, plan.target - plan.trained);
  const met = plan.trained >= plan.target;
  // Free evenings against what is still owed: the number that actually says
  // whether the week is in trouble.
  const tight = !met && plan.free <= owed;

  line(w, "IRON LEDGER", MUTED, 9, true);
  w.addSpacer(6);

  const head = w.addStack();
  head.centerAlignContent();
  line(head, String(plan.trained), met ? DONE : INK, 34, true);
  line(head, " / " + plan.target, MUTED, 15, true);

  w.addSpacer(2);
  line(w, met ? "week done" : owed + (owed === 1 ? " session left" : " sessions left"),
    met ? DONE : (tight ? MISS : MUTED), 11, false);

  w.addSpacer(8);

  if (session.loggedToday) {
    line(w, "Logged today", DONE, 12, true);
  } else if (plan.restDayToday) {
    line(w, "Rest day, earned", WARN, 12, true);
  } else {
    line(w, "Next: " + session.session + " — " + (session.name || ""), INK, 12, true);
  }

  const busyTonight = (plan.busy || []).find((b) => b.date === session.date);
  if (busyTonight) {
    line(w, "Tonight: " + (busyTonight.what === true ? "spoken for" : busyTonight.what), WARN, 10, false);
  } else if (!met) {
    line(w, plan.free + (plan.free === 1 ? " free evening" : " free evenings") + " left",
      tight ? MISS : MUTED, 10, false);
  }

  w.addSpacer();
  const foot = w.addStack();
  const stamp = new Date();
  line(foot, "updated " + String(stamp.getHours()).padStart(2, "0") + ":"
    + String(stamp.getMinutes()).padStart(2, "0"), MUTED, 8, false);
} catch (err) {
  line(w, "IRON LEDGER", MUTED, 9, true);
  w.addSpacer(6);
  /* A widget that says nothing when it fails is worse than one that admits
     it: you would read a stale week as a current one. */
  line(w, "Can't reach it", MISS, 13, true);
  w.addSpacer(2);
  const e = w.addText(String(err.message || err).slice(0, 60));
  e.textColor = MUTED;
  e.font = Font.systemFont(9);
  e.lineLimit = 2;
}

w.url = BASE;
if (config.runsInWidget) Script.setWidget(w);
else await w.presentSmall();
Script.complete();
