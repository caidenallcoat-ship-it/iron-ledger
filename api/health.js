/**
 * POST /api/health  { date?, sleep: {asleepAt|hours}, ... } -> fold Health data in
 * GET  /api/health                                         -> what to write back
 *
 * Apple Health has no web API and never will have one — HealthKit is native
 * only, so a page in Safari cannot read a single sample from it. What *can*
 * reach it is Shortcuts, which has Find Health Samples and Log Health Sample
 * actions, so this is the seam: a Shortcut reads Health and posts here, and
 * reads here to write a session back into Health.
 *
 * Only sleep is folded in, deliberately. It is the one thing the app asks you
 * to tick by hand that your phone already knows, and manual logging fatigue is
 * one of the top reasons people abandon a tracker. Weight and steps are easy
 * to accept and would be dead data — nothing in the app reads them yet.
 *
 * Same LEDGER_KEY as everything else, same lockout on repeated bad keys.
 */
import { redis, authorise, loadState, localParts, STATE_DOC, hasPass } from "./_lib.js";


/** "23:12", "2026-09-08T23:12:00Z" or 23.2 -> hours past midnight, or null. */
export function bedHour(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v >= 0 && v < 24 ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  // A full timestamp: take its local wall-clock time as given.
  const iso = s.match(/T(\d{2}):(\d{2})/);
  if (iso) return Number(iso[1]) + Number(iso[2]) / 60;
  const hm = s.match(/^(\d{1,2})[:.](\d{2})/);
  if (hm) {
    const h = Number(hm[1]);
    return h >= 0 && h < 24 ? h + Number(hm[2]) / 60 : null;
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n < 24 ? n : null;
}

/**
 * Did this count as getting to bed on time?
 *
 * `by` is an hour like 23. Anything after midnight is the small hours of the
 * same night, so 01:30 has to read as later than 23:00 rather than earlier —
 * that is the whole trick, and getting it wrong would quietly mark every late
 * night as a good one.
 */
export function inBedOnTime(hour, by) {
  if (hour === null) return null;
  const shifted = hour < 12 ? hour + 24 : hour;
  const target = by < 12 ? by + 24 : by;
  return shifted <= target;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const auth = await authorise(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  try {
    const state = await loadState();
    if (!state) return res.status(404).json({ error: "no_record_yet" });
    const today = localParts().key;

    if (req.method === "GET") {
      /* What a Shortcut needs to write a workout back into Health: whether
         today's session happened, and roughly how long it was. */
      const rec = (state.done || {})[today] || null;
      return res.status(200).json({
        date: today,
        trained: Boolean(rec),
        session: rec ? rec.key : null,
        express: rec ? Boolean(rec.express) : false,
        minutes: rec ? (rec.express ? 15 : 30) : 0,
        restDay: hasPass(state.passes || {}, today, "rest"),
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
    if (!body || typeof body !== "object") return res.status(400).json({ error: "nothing_to_add" });

    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? body.date : today;
    if (date > today) return res.status(400).json({ error: "date_in_the_future" });

    /* Weight is accepted now that something reads it: the eating panel shows
       a four-week direction. It is stored per day and never shown as a daily
       number. */
    const kg = Number(body.weight !== undefined ? body.weight : (body.kg !== undefined ? body.kg : NaN));
    let weightSet = null;
    if (Number.isFinite(kg)) {
      if (kg < 20 || kg > 400) {
        return res.status(400).json({ error: "implausible_weight", got: kg });
      }
      if (!state.weight || typeof state.weight !== "object") state.weight = {};
      weightSet = Math.round(kg * 10) / 10;
      state.weight[date] = weightSet;
    }

    const sleep = body.sleep || (body.asleepAt || body.hours ? body : null);
    if (!sleep && weightSet === null) {
      return res.status(400).json({ error: "nothing_to_record" });
    }
    if (!sleep) {
      state.updatedAt = Date.now();
      await redis(["SET", STATE_DOC, JSON.stringify(state)]);
      return res.status(200).json({ ok: true, date, weight: weightSet });
    }

    const by = Number(
      state.areas && state.areas.sleep && state.areas.sleep.by
    ) || 23;
    const hour = bedHour(sleep.asleepAt !== undefined ? sleep.asleepAt : sleep.at);
    const onTime = inBedOnTime(hour, by);
    if (onTime === null) {
      return res.status(400).json({
        error: "unreadable_time",
        message: 'Send sleep.asleepAt as "23:12" or a full timestamp.',
      });
    }

    if (!state.daily || typeof state.daily !== "object") state.daily = {};
    const day = state.daily[date] || (state.daily[date] = {});
    day.bed = onTime;
    day.bedVia = "health";
    if (Number.isFinite(Number(sleep.hours))) day.slept = Math.round(Number(sleep.hours) * 10) / 10;
    if (!Object.keys(day).length) delete state.daily[date];

    state.updatedAt = Date.now();
    await redis(["SET", STATE_DOC, JSON.stringify(state)]);

    return res.status(200).json({
      ok: true,
      date,
      asleepAt: hour,
      target: by,
      onTime,
      hours: day.slept !== undefined ? day.slept : null,
      weight: weightSet,
    });
  } catch (err) {
    return res.status(502).json({ error: "health_failed", detail: String(err.message || err) });
  }
}
