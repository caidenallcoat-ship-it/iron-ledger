/**
 * POST /api/spend  { amount, note?, date? }  -> add to a day's spending
 * POST /api/spend  { set: 12.50, date? }     -> replace a day's total
 * GET  /api/spend                            -> the week against the cap
 *
 * Spending is the last thing in the ledger that has to be typed in by hand.
 * This is the seam for anything that can make an HTTP request: a Siri phrase,
 * a Shortcut, or a bank feed if one is ever wired up.
 *
 * `amount` adds, `set` replaces. A bank feed replaying the same day should use
 * `set`, because adding twice would double the day; a person saying "log a
 * tenner" means add.
 */
import { authorise, localParts } from "./_lib.js";
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
const round2 = (n) => Math.round(n * 100) / 100;

/** "12.50", "£12.50", 12.5 -> 12.5, or null if it isn't money. */
export function readAmount(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[£$,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > 100000) return null;
  return round2(n);
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
    const cap = Number(state.areas && state.areas.money && state.areas.money.cap) || 100;
    if (!state.spend || typeof state.spend !== "object") state.spend = {};

    /* An earned off-budget day comes out of the cap, never out of the total —
       the same rule the app itself follows. */
    const passes = state.passes || {};
    const isExcused = (k) => {
      const v = passes[k];
      return Array.isArray(v) ? v.indexOf("spend") > -1 : v === "spend";
    };
    const week = () => {
      let counted = 0, excused = 0;
      for (let i = 0; i < 7; i++) {
        const k = addDays(monday, i);
        const amt = Number(state.spend[k]) || 0;
        if (isExcused(k)) excused += amt; else counted += amt;
      }
      return { counted: round2(counted), excused: round2(excused), total: round2(counted + excused) };
    };

    if (req.method === "GET") {
      const w = week();
      return res.status(200).json({
        week: monday, cap, ...w, left: round2(cap - w.counted), over: w.counted > cap,
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
    body = body || {};

    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? body.date : today;
    if (date > today) return res.status(400).json({ error: "date_in_the_future" });

    const replacing = body.set !== undefined;
    const amount = readAmount(replacing ? body.set : body.amount);
    if (amount === null) {
      return res.status(400).json({
        error: "bad_amount",
        message: "Send amount (to add) or set (to replace the day), as a number.",
      });
    }
    if (replacing && amount < 0) return res.status(400).json({ error: "negative_total" });

    const was = round2(Number(state.spend[date]) || 0);
    const now = replacing ? amount : round2(was + amount);
    if (now < 0) return res.status(400).json({ error: "negative_total", was, amount });
    if (now === 0) delete state.spend[date]; else state.spend[date] = now;

    await saveFor(auth.uid, state);

    const w = week();
    return res.status(200).json({
      ok: true, date, was, now, cap, ...w,
      left: round2(cap - w.counted), over: w.counted > cap,
      offBudgetDay: isExcused(date),
    });
  } catch (err) {
    return res.status(502).json({ error: "spend_failed", detail: String(err.message || err) });
  }
}
