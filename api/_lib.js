/**
 * Shared bits for the Iron Ledger API: the Redis connection, the shared-secret
 * check, and the nudge composer.
 *
 * The nudge is written here rather than by a model because it has to fire from
 * a cron with nothing else running. The rules are the same ones the page uses:
 * the week is the unit of success, one missed session is noise and two is a
 * pattern, and coming back from a break is never lectured at.
 */

const STORE_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const STORE_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const STATE_DOC = "iron-ledger:state";
export const SUBS_HASH = "iron-ledger:subs";
export const FAIL_PREFIX = "iron-ledger:fail:";

/**
 * Crude but sufficient brute-force brake. The key is the only thing standing
 * between a public URL and the record, so a wrong key costs the caller their
 * budget for a while. Counted per client IP, in Redis, expiring on its own.
 */
const MAX_FAILURES = 10;
const WINDOW_SECONDS = 900;

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.headers["x-real-ip"] || "unknown";
}

/** True when this caller has burned through its allowance. */
export async function isLockedOut(req) {
  try {
    const out = await redis(["GET", FAIL_PREFIX + clientIp(req)]);
    return Number(out && out.result) >= MAX_FAILURES;
  } catch {
    return false; // never lock someone out because the store hiccuped
  }
}

export async function noteFailure(req) {
  try {
    const k = FAIL_PREFIX + clientIp(req);
    const out = await redis(["INCR", k]);
    if (Number(out && out.result) === 1) await redis(["EXPIRE", k, WINDOW_SECONDS]);
  } catch {}
}

export async function clearFailures(req) {
  try { await redis(["DEL", FAIL_PREFIX + clientIp(req)]); } catch {}
}

export function storeConfigured() {
  return Boolean(STORE_URL && STORE_TOKEN);
}

export async function redis(command) {
  const res = await fetch(STORE_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + STORE_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error("store responded " + res.status);
  return res.json();
}

/** Constant-time-ish compare so a secret can't be probed a byte at a time. */
export function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function loadState() {
  const out = await redis(["GET", STATE_DOC]);
  const raw = out && out.result;
  return raw ? JSON.parse(raw) : null;
}

/* ------------------------------------------------------------------ */
/* the programme                                                        */
/* ------------------------------------------------------------------ */

const SESSIONS = {
  A: { name: "Swing", day: 1 },
  B: { name: "Wind", day: 2 },
  C: { name: "Pull", day: 4 },
  D: { name: "Press", day: 5 },
  E: { name: "Grinder", day: 6 },
};
const BY_DAY = { 1: "A", 2: "B", 4: "C", 5: "D", 6: "E" };
const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

/** Today's date parts in a given timezone, so a UTC cron reasons in local time. */
export function localParts(tz = "Europe/London", when = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", weekday: "short", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(when).map((x) => [x.type, x.value]));
  const key = `${p.year}-${p.month}-${p.day}`;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { key, hour: Number(p.hour), dow };
}

function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function dowOf(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function daysBetween(a, b) {
  return Math.round(
    (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000
  );
}
function plural(n, w) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

/**
 * Compose the nudge. Returns null when there is genuinely nothing to say,
 * so a quiet day stays quiet instead of manufacturing a problem.
 */
export function buildNudge(state, todayKey) {
  if (!state) {
    return { title: "Iron Ledger", body: "No record found. Open the app and log something." };
  }

  const done = state.done || {};
  const skips = state.skips || [];
  const ticks = state.ticks || {};
  const target = Number(state.target) >= 1 && Number(state.target) <= 7 ? Number(state.target) : 3;
  const start = state.start || todayKey;

  const dow = dowOf(todayKey);
  const sk = BY_DAY[dow];
  const session = sk ? SESSIONS[sk] : null;
  const doneToday = Boolean(done[todayKey]);

  // This week, Monday-start.
  const monday = addDays(todayKey, -((dow + 6) % 7));
  let weekDone = 0;
  for (let i = 0; i < 7; i++) if (done[addDays(monday, i)]) weekDone++;
  let daysLeft = 0;
  for (let i = 0; i < 7; i++) {
    const k = addDays(monday, i);
    if (k >= todayKey && BY_DAY[dowOf(k)]) daysLeft++;
  }

  const doneKeys = Object.keys(done).sort();
  const last = doneKeys.length ? doneKeys[doneKeys.length - 1] : null;
  const gap = last ? daysBetween(last, todayKey) : null;

  // Two scheduled days in a row missed, before today.
  const seen = [];
  for (let i = 1; i <= 14 && seen.length < 2; i++) {
    const k = addDays(todayKey, -i);
    if (k < start) break;
    if (BY_DAY[dowOf(k)]) seen.push(Boolean(done[k]));
  }
  const missedTwice = seen.length === 2 && !seen[0] && !seen[1];

  // Excuses.
  const tally = {};
  for (const s of skips) tally[s.reason] = (tally[s.reason] || 0) + 1;
  const topReason = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0] || null;
  const topCount = topReason ? tally[topReason] : 0;

  // The house.
  let worstJob = null, overdueCount = 0;
  if (Array.isArray(state.chores)) {
    for (const c of state.chores) {
      const over = c.last ? daysBetween(c.last, todayKey) - c.every : 9999;
      if (over > 0) overdueCount++;
      if (!worstJob || over > worstJob.over) worstJob = { name: c.name, over, never: !c.last };
    }
  }
  const jobLine = worstJob && worstJob.over > 0
    ? worstJob.never
      ? ` ${worstJob.name} still hasn't been done — ${overdueCount} jobs behind.`
      : ` ${worstJob.name} is ${plural(worstJob.over, "day")} past due; ${overdueCount} behind.`
    : "";

  const link = "";
  const T = "Iron Ledger";

  // Week already met — nothing is owed.
  if (weekDone >= target) {
    if (!jobLine) return null;
    return { title: T, body: `Week's done — ${weekDone} of ${target}.${jobLine}` };
  }

  // Day one.
  const elapsedTrainingDays = (() => {
    let n = 0;
    for (let k = start; k < todayKey; k = addDays(k, 1)) if (BY_DAY[dowOf(k)]) n++;
    return n;
  })();

  if (doneKeys.length === 0 && elapsedTrainingDays === 0) {
    const started = Array.isArray(ticks[todayKey]) && ticks[todayKey].length;
    if (!session) return { title: T, body: `Nothing logged yet. Target is ${target} sessions a week.${jobLine}` };
    return {
      title: T,
      body: started
        ? `You ticked ${plural(ticks[todayKey].length, "exercise")} and stopped. Session ${sk} — ${session.name}, about 30 minutes. Finish it.`
        : `Day one — Session ${sk}, ${session.name}, about 30 minutes from 18:30. Target is ${target} a week, not all five.`,
    };
  }

  if (doneKeys.length === 0) {
    return {
      title: T,
      body: `You've never finished a session. ${plural(elapsedTrainingDays, "training day")} have gone by since you started.${jobLine}`,
    };
  }

  if (doneToday) {
    return jobLine
      ? { title: T, body: `${weekDone} of ${target} this week.${jobLine}` }
      : null;
  }

  // Back from a real break — no lecture, just today.
  if (gap !== null && gap >= 7) {
    return {
      title: T,
      body: session
        ? `${plural(gap, "day")} off. Session ${sk} tonight — take the short version, it counts. The first one back is the only hard one.`
        : `${plural(gap, "day")} off. Next session is tomorrow. Nothing to rebuild, just start.`,
    };
  }

  if (missedTwice) {
    return {
      title: T,
      body: `That's two in a row — that's how it stops.${topReason ? ` "${topReason}" ${topCount}×.` : ""}${session ? ` Session ${sk} tonight, short version if that's what it takes.` : ""}`,
    };
  }

  if (session && daysLeft <= target - weekDone) {
    return {
      title: T,
      body: `${weekDone} of ${target}, and ${plural(daysLeft, "session")} left to get there. Every one is compulsory now. Session ${sk} — ${session.name}.`,
    };
  }

  if (session) {
    return {
      title: T,
      body: `${weekDone} of ${target} this week. Session ${sk} — ${session.name}, 18:30, about 30 minutes.${jobLine}`,
    };
  }

  // Rest day, still short on the week.
  return {
    title: T,
    body: `Rest day. ${weekDone} of ${target}, ${plural(daysLeft, "training day")} left.${jobLine || " Good evening to clear a job."}`,
  };
}
