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
const CYCLE = ["A", "B", "C", "D", "E"];

/** Next in the cycle after the last one actually completed. */
function nextSessionKey(done) {
  const days = Object.keys(done).sort();
  for (let i = days.length - 1; i >= 0; i--) {
    const k = done[days[i]] && done[days[i]].key;
    if (CYCLE.indexOf(k) > -1) return CYCLE[(CYCLE.indexOf(k) + 1) % CYCLE.length];
  }
  return CYCLE[0];
}
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
  const sk = done[todayKey] && done[todayKey].key ? done[todayKey].key : nextSessionKey(done);
  const session = SESSIONS[sk];
  const doneToday = Boolean(done[todayKey]);

  // This week, Monday-start.
  const monday = addDays(todayKey, -((dow + 6) % 7));
  let weekDone = 0;
  for (let i = 0; i < 7; i++) if (done[addDays(monday, i)]) weekDone++;
  // Every remaining day is a possible training day now.
  let daysLeft = 0;
  for (let i = 0; i < 7; i++) if (addDays(monday, i) >= todayKey) daysLeft++;

  const doneKeys = Object.keys(done).sort();
  const last = doneKeys.length ? doneKeys[doneKeys.length - 1] : null;
  const gap = last ? daysBetween(last, todayKey) : null;

  // Never-miss-twice for a queue: quiet for two days while short on the week.
  const drifting = gap !== null && gap >= 2 && weekDone < target;

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
  const elapsedDays = daysBetween(start, todayKey);

  if (doneKeys.length === 0 && elapsedDays === 0) {
    const started = Array.isArray(ticks[todayKey]) && ticks[todayKey].length;
    return {
      title: T,
      body: started
        ? `You ticked ${plural(ticks[todayKey].length, "exercise")} and stopped. Session ${sk} — ${session.name}, about 30 minutes. Finish it.`
        : `Day one — Session ${sk}, ${session.name}, about 30 minutes from 18:30. Target is ${plural(target, "session")} a week, on whatever days suit.`,
    };
  }

  if (doneKeys.length === 0) {
    return {
      title: T,
      body: `You've never finished a session. ${plural(elapsedDays, "day")} since you started, and Session ${sk} is still first in the queue.${jobLine}`,
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
      body: `${plural(gap, "day")} off. Session ${sk} is next — take the short version, it counts. The first one back is the only hard one.`,
    };
  }

  if (drifting) {
    return {
      title: T,
      body: `Two days quiet and short on the week.${topReason ? ` "${topReason}" ${topCount}×.` : ""} Session ${sk} — ${session.name}, short version if that's what it takes.`,
    };
  }

  if (daysLeft <= target - weekDone) {
    return {
      title: T,
      body: `${weekDone} of ${target}, ${plural(daysLeft, "day")} left. Every one counts now. Session ${sk} — ${session.name}.`,
    };
  }

  return {
    title: T,
    body: `${weekDone} of ${target} this week. Session ${sk} — ${session.name}, about 30 minutes.${jobLine}`,
  };
}
