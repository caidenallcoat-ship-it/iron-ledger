/**
 * POST /api/plan  { busy: [{date, what}] }  -> which evenings are spoken for
 * GET  /api/plan                            -> the week as the app sees it
 *
 * Calendar has no web API either, so this is the same seam as Health: a
 * Shortcut reads the next seven days of events in your training window and
 * posts the dates here.
 *
 * A booked evening never lowers the target. Life filling up is a reason to
 * start earlier in the week, not a reason to owe less — a calendar that
 * excused sessions would just be a way of writing the week off in advance.
 * What it changes is when the app starts warning, and what it says on the
 * night itself.
 */
import { authorise, localParts, hasPass } from "./_lib.js";
import { loadFor, saveFor } from "./_users.js";

const HORIZON_DAYS = 14;

/** Monday of the week containing `key`. */
function mondayOf(key) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}
function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Evenings this week that are still usable: not past, not booked, not done. */
export function freeEvenings(state, today) {
  const monday = mondayOf(today);
  const busy = state.busy || {};
  const done = state.done || {};
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const k = addDays(monday, i);
    if (k >= today && !busy[k] && !done[k]) n++;
  }
  return n;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const auth = await authorise(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  try {
    const state = await loadFor(auth.uid);
    if (!state) return res.status(404).json({ error: "no_record_yet" });
    const today = localParts().key;
    const monday = mondayOf(today);
    const target = Number(state.target) >= 1 && Number(state.target) <= 7 ? Number(state.target) : 3;

    if (req.method === "GET") {
      const done = state.done || {};
      let trained = 0;
      for (let i = 0; i < 7; i++) if (done[addDays(monday, i)]) trained++;
      const busy = state.busy || {};
      return res.status(200).json({
        week: monday,
        target,
        trained,
        free: freeEvenings(state, today),
        busy: Object.keys(busy).filter((k) => k >= today).sort()
          .map((k) => ({ date: k, what: busy[k] })),
        restDayToday: hasPass(state.passes || {}, today, "rest"),
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad_json" }); }
    }
    const incoming = Array.isArray(body && body.busy) ? body.busy : null;
    if (!incoming) return res.status(400).json({ error: "expected_busy_array" });

    const horizon = addDays(today, HORIZON_DAYS);
    if (!state.busy || typeof state.busy !== "object") state.busy = {};

    /* A calendar is the authority on its own dates, so the window is replaced
       rather than merged — otherwise an event you cancelled would haunt the
       app forever, and nothing would ever clear it. */
    for (const k of Object.keys(state.busy)) {
      if (k >= today && k <= horizon) delete state.busy[k];
    }
    // Anything older than a fortnight has done its job.
    const floor = addDays(today, -14);
    for (const k of Object.keys(state.busy)) if (k < floor) delete state.busy[k];

    const set = [];
    for (const entry of incoming) {
      const date = String((entry && entry.date) || entry || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "bad_date", detail: date });
      }
      if (date < today || date > horizon) continue;   // outside the window we manage
      const what = entry && entry.what ? String(entry.what).slice(0, 60) : true;
      state.busy[date] = what;
      set.push({ date, what });
    }

    await saveFor(auth.uid, state);

    return res.status(200).json({
      ok: true,
      week: monday,
      target,
      booked: set.length,
      busy: set,
      free: freeEvenings(state, today),
    });
  } catch (err) {
    return res.status(502).json({ error: "plan_failed", detail: String(err.message || err) });
  }
}
