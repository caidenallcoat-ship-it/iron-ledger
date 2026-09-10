/**
 * POST   /api/session  { express?, note?, date? }  -> log a session
 * DELETE /api/session  { date? }                   -> unlog one
 * GET    /api/session                              -> what is next, the week, and
 *                                                    whether tonight is still owed
 *
 * The hole this fills: everything else could read training and nothing could
 * record it. A watch finishing a workout, a Siri phrase on the way to the
 * shower, an automation — none of them could touch the one thing the app is
 * actually about.
 *
 * The session key is never accepted from the caller. The programme runs as a
 * rotating queue, so which session comes next is a fact about the record, not
 * something an automation should be able to assert.
 */
import { authorise, localParts, SESSIONS, nextSessionKey, tonight } from "./_lib.js";
import { loadFor, saveFor } from "./_users.js";

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
function weekCount(done, today) {
  const monday = mondayOf(today);
  let n = 0;
  for (let i = 0; i < 7; i++) if (done[addDays(monday, i)]) n++;
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
    const done = state.done || (state.done = {});
    const target = Number(state.target) >= 1 && Number(state.target) <= 7 ? Number(state.target) : 3;

    if (req.method === "GET") {
      const rec = done[today] || null;
      const key = rec ? rec.key : nextSessionKey(done);
      /* owed / why / line are for the phone lock (SHORTCUTS.md): whether
         tonight still counts, as a plain word a Shortcut can compare. */
      const t = tonight(state, today);
      return res.status(200).json({
        owed: t.owed,
        why: t.why,
        line: t.line,
        date: today,
        loggedToday: Boolean(rec),
        session: key,
        name: SESSIONS[key] ? SESSIONS[key].name : null,
        express: rec ? Boolean(rec.express) : false,
        thisWeek: weekCount(done, today),
        target,
      });
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad_json" }); }
    }
    body = body || {};

    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? body.date : today;
    if (date > today) return res.status(400).json({ error: "date_in_the_future" });

    if (req.method === "DELETE") {
      if (!done[date]) return res.status(404).json({ error: "nothing_logged", date });
      const was = done[date];
      delete done[date];
      await saveFor(auth.uid, state);
      return res.status(200).json({
        ok: true, removed: { date, session: was.key }, thisWeek: weekCount(done, today), target,
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, DELETE");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    /* Logging the same day twice is an automation misfiring, not two sessions
       — the record is one per day everywhere else, so say so rather than
       silently overwriting what is already there. */
    if (done[date]) {
      return res.status(409).json({
        error: "already_logged",
        date,
        session: done[date].key,
        express: Boolean(done[date].express),
      });
    }

    const key = nextSessionKey(done);
    const rec = { key, at: new Date().toISOString(), express: Boolean(body.express) };
    if (body.via !== undefined) rec.via = String(body.via).slice(0, 24);
    else rec.via = "api";
    const note = body.note === undefined ? "" : String(body.note).trim().slice(0, 80);
    if (note) rec.note = note;
    done[date] = rec;

    await saveFor(auth.uid, state);

    const n = weekCount(done, today);
    return res.status(200).json({
      ok: true,
      date,
      session: key,
      name: SESSIONS[key] ? SESSIONS[key].name : null,
      express: rec.express,
      thisWeek: n,
      target,
      weekMet: n >= target,
    });
  } catch (err) {
    return res.status(502).json({ error: "session_failed", detail: String(err.message || err) });
  }
}
