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

/**
 * One gate for every endpoint.
 *
 * The lockout deliberately guards only WRONG keys. It used to run before the
 * key was checked at all, so ten bad attempts from an address locked out the
 * person holding the right key for fifteen minutes — and on a home
 * connection, or behind any shared NAT or office line, that is the same
 * address. Guessing is still stopped dead at ten tries; being right is no
 * longer punished for someone else's mistakes.
 */
export async function authorise(req) {
  if (!storeConfigured()) {
    return { ok: false, status: 503, body: {
      error: "storage_not_configured",
      message: "No Redis store is connected. Add the Upstash for Redis integration in the Vercel dashboard and redeploy.",
    } };
  }
  if (!process.env.LEDGER_KEY) {
    return { ok: false, status: 503, body: {
      error: "key_not_configured",
      message: "Set the LEDGER_KEY environment variable in Vercel and redeploy.",
    } };
  }
  if (sameSecret(req.headers["x-ledger-key"], process.env.LEDGER_KEY)) {
    await clearFailures(req);
    return { ok: true };
  }
  if (await isLockedOut(req)) {
    return { ok: false, status: 429, body: { error: "too_many_attempts" } };
  }
  await noteFailure(req);
  return { ok: false, status: 401, body: { error: "bad_key" } };
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
/* Mirrors RANKS / credited() in iron-ledger.html. The notification is the
   only part of this that reaches a phone, so it should speak with the same
   voice as the app rather than treating a hundred sessions like none. Short
   versions count as half, same as in the app. */
const RANKS = [
  [0, "Unproven"], [4, "Started"], [12, "Regular"],
  [24, "Established"], [48, "Ingrained"], [96, "Permanent"],
];
export function rankOf(done) {
  let n = 0;
  for (const k in done) n += done[k] && done[k].express ? 0.5 : 1;
  n = Math.floor(n);
  let name = RANKS[0][1];
  for (const [at, label] of RANKS) if (n >= at) name = label;
  return { n, name };
}

/* A day can carry several bought effects, so this reads an array. Records
   written before that change hold a bare string, and both shapes have to keep
   working — the notification must not start nagging on a rest day because of
   how the day was stored. */
export function hasPass(passes, k, kind) {
  const v = passes && passes[k];
  if (!v) return false;
  return Array.isArray(v) ? v.indexOf(kind) > -1 : v === kind;
}

export function buildNudge(state, todayKey) {
  if (!state) {
    return { title: "Iron Ledger", body: "No record found. Open the app and log something." };
  }

  const done = state.done || {};
  const passes = state.passes || {};
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
  let weekDone = 0, weekRested = 0;
  for (let i = 0; i < 7; i++) {
    const k = addDays(monday, i);
    if (done[k]) weekDone++;
    else if (hasPass(passes, k, "rest")) weekRested++;
  }
  /* A rest day comes off what the week asks of you; it is never counted as a
     session. weekDone stays the true number so the nudge and the app agree. */
  const bar = Math.max(1, target - weekRested);
  // Every remaining day is a possible training day now.
  let daysLeft = 0;
  for (let i = 0; i < 7; i++) if (addDays(monday, i) >= todayKey) daysLeft++;

  const doneKeys = Object.keys(done).sort();
  const last = doneKeys.length ? doneKeys[doneKeys.length - 1] : null;
  const gap = last ? daysBetween(last, todayKey) : null;

  // Never-miss-twice for a queue: quiet for two days while short on the week.
  const drifting = gap !== null && gap >= 2 && weekDone < bar;

  // Excuses.
  const tally = {};
  for (const s of skips) tally[s.reason] = (tally[s.reason] || 0) + 1;
  const topReason = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0] || null;
  const topCount = topReason ? tally[topReason] : 0;

  /* One supporting line, chosen from everything the app tracks. It used to
     look only at the house, so eating, sleep, money, people and the weekly
     tasks were invisible to the only thing that reaches a phone. Each
     candidate carries a severity so the worst one wins, and the goal set
     during setup breaks ties. */
  const candidates = [];

  if (Array.isArray(state.chores)) {
    let worst = null, behind = 0;
    for (const c of state.chores) {
      const over = c.last ? daysBetween(c.last, todayKey) - c.every : 9999;
      if (over > 0) behind++;
      if (!worst || over > worst.over) worst = { name: c.name, over, never: !c.last };
    }
    if (worst && worst.over > 0) {
      candidates.push({
        area: "order", severity: Math.min(worst.never ? 30 : worst.over, 60),
        line: worst.never
          ? `${worst.name} still hasn't been done — ${behind} jobs behind.`
          : `${worst.name} is ${plural(worst.over, "day")} past due; ${behind} behind.`,
      });
    }
  }

  if (Array.isArray(state.people)) {
    let worst = null;
    for (const p of state.people) {
      if (!p.last) continue;                     // never logged isn't a fact about them
      const since = daysBetween(p.last, todayKey);
      const over = since - p.every;
      if (over > 0 && (!worst || over > worst.over)) worst = { name: p.name, over, since };
    }
    if (worst) {
      const how = worst.since >= 14
        ? plural(Math.floor(worst.since / 7), "week")
        : plural(worst.since, "day");
      candidates.push({
        area: "order", severity: Math.min(worst.over, 60),
        line: `You haven't spoken to ${worst.name} in ${how}.`,
      });
    }
  }

  const cap = state.areas && state.areas.money ? Number(state.areas.money.cap) : 0;
  if (cap > 0 && state.spend) {
    let spent = 0;
    for (let i = 0; i < 7; i++) spent += Number(state.spend[addDays(monday, i)]) || 0;
    if (spent > cap) {
      candidates.push({
        area: "order", severity: 25 + Math.min(20, Math.round((spent - cap) / cap * 20)),
        line: `You're £${Math.round(spent - cap)} over the week's spending cap.`,
      });
    }
  }

  // Eating and sleep, but only once the week is far enough along to matter.
  const dailyCfg = state.areas || {};
  if (state.daily && daysLeft <= 3) {
    let ate = 0, slept = 0;
    for (let i = 0; i < 7; i++) {
      const m = state.daily[addDays(monday, i)] || {};
      if (m.protein && m.nojunk) ate++;
      if (m.bed) slept++;
    }
    const eatT = dailyCfg.eat ? dailyCfg.eat.target : 5;
    const slpT = dailyCfg.sleep ? dailyCfg.sleep.target : 5;
    if (ate < eatT) candidates.push({ area: "lean", severity: 10 + (eatT - ate) * 3,
      line: `Eating is ${ate} of ${eatT} with ${plural(daysLeft, "day")} left.` });
    if (slept < slpT) candidates.push({ area: "strong", severity: 10 + (slpT - slept) * 3,
      line: `In bed on time ${slept} of ${slpT} nights — that's the bit that decides whether the training does anything.` });
  }

  // Weekly tasks, and especially ones being rewritten week after week.
  if (state.weekly && typeof state.weekly === "object") {
    let open = 0, worstCarried = null;
    for (const a of Object.keys(state.weekly)) {
      for (const t of state.weekly[a] || []) {
        if (t.done) continue;
        open++;
        if (t.carried && (!worstCarried || t.carried > worstCarried.carried)) worstCarried = t;
      }
    }
    if (worstCarried) {
      candidates.push({ area: "order", severity: 20 + worstCarried.carried * 12,
        line: `"${worstCarried.text}" has been on the list ${plural(worstCarried.carried + 1, "week")} now.` });
    } else if (open) {
      candidates.push({ area: "order", severity: 8,
        line: `${plural(open, "task")} still on this week's list.` });
    }
  }

  const goal = state.goal || null;
  candidates.sort((a, b) =>
    (b.severity + (b.area === goal ? 8 : 0)) - (a.severity + (a.area === goal ? 8 : 0))
  );
  const jobLine = candidates.length ? " " + candidates[0].line : "";

  const link = "";
  const T = "Iron Ledger";

  /* A rest day you earned and chose is the one evening this app has nothing
     to say about training. Anything else outstanding still gets its line —
     the day off was from the session, not from the bins. */
  /* An evening bought off the ledger: the app says nothing at all, including
     about the bins. That is the whole product. */
  if (hasPass(passes, todayKey, "quiet")) return null;

  if (hasPass(passes, todayKey, "rest")) {
    return jobLine
      ? { title: T, body: `Rest day, earned.${jobLine}` }
      : null;
  }

  // Week already met — nothing is owed.
  if (weekDone >= bar) {
    if (!jobLine) return null;
    return {
      title: T,
      body: `Week's done — ${weekDone} of ${target}${weekRested ? `, ${plural(weekRested, "rest day")} earned` : ""}.${jobLine}`,
    };
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
    const r = rankOf(done);
    /* Someone with a real record behind them needs reminding what's at
       stake, not telling how to start. Someone with four sessions doesn't
       have anything to lose yet, and saying otherwise would be flattery. */
    return {
      title: T,
      body: r.n >= 24
        ? `${plural(gap, "day")} off, against ${r.n} sessions banked. You don't lose that in a fortnight — you lose it in three months. Session ${sk}, short version, tonight.`
        : `${plural(gap, "day")} off. Session ${sk} is next — take the short version, it counts. The first one back is the only hard one.`,
    };
  }

  if (drifting) {
    return {
      title: T,
      body: `Two days quiet and short on the week.${topReason ? ` "${topReason}" ${topCount}×.` : ""} Session ${sk} — ${session.name}, short version if that's what it takes.`,
    };
  }

  if (daysLeft <= bar - weekDone) {
    return {
      title: T,
      body: `${weekDone} of ${target}, ${plural(daysLeft, "day")} left. Every one counts now. Session ${sk} — ${session.name}.`,
    };
  }

  const rank = rankOf(done);
  return {
    title: rank.n >= 12 ? `${T} — ${rank.name}` : T,
    body: `${weekDone} of ${target} this week. Session ${sk} — ${session.name}, about 30 minutes.${jobLine}`,
  };
}
