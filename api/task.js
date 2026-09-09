/**
 * GET  /api/task            -> what is outstanding this week
 * POST /api/task  {area,text} -> add a task to that area's week
 * POST /api/task  {tasks:[{area,text},...]} -> add several at once
 *
 * Exists so anything that can make an HTTP request can put work into the
 * ledger: an iOS Shortcut reading Reminders, a Siri phrase, a calendar
 * automation. Apple's own apps have no web API, so this is the seam.
 *
 * Same LEDGER_KEY as everything else, same lockout on repeated bad keys.
 */
import {
  redis, sameSecret, storeConfigured, loadState, localParts,
  isLockedOut, noteFailure, clearFailures, STATE_DOC,
} from "./_lib.js";

const LEDGER_KEY = process.env.LEDGER_KEY;
const AREAS = ["house", "train", "eat", "money", "sleep", "people"];
const MAX_PER_AREA = 40;

/** Monday of the week containing `key`, as YYYY-MM-DD. */
function mondayOf(key) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

function normalise(entry) {
  const area = String(entry && entry.area || "").toLowerCase().trim();
  const text = String(entry && entry.text || "").trim().slice(0, 80);
  if (!AREAS.includes(area)) return { error: `area must be one of: ${AREAS.join(", ")}` };
  if (!text) return { error: "text is required" };
  return { area, text };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!storeConfigured()) return res.status(503).json({ error: "storage_not_configured" });
  if (!LEDGER_KEY) return res.status(503).json({ error: "key_not_configured" });
  if (await isLockedOut(req)) return res.status(429).json({ error: "too_many_attempts" });
  if (!sameSecret(req.headers["x-ledger-key"], LEDGER_KEY)) {
    await noteFailure(req);
    return res.status(401).json({ error: "bad_key" });
  }
  await clearFailures(req);

  try {
    const state = await loadState();
    if (!state) return res.status(404).json({ error: "no_record_yet" });

    const monday = mondayOf(localParts().key);

    if (req.method === "GET") {
      const weekly = state.weekly || {};
      const out = {};
      let total = 0;
      for (const a of AREAS) {
        const open = (weekly[a] || []).filter((t) => !t.done);
        if (open.length) {
          out[a] = open.map((t) => ({ text: t.text, carried: t.carried || 0 }));
          total += open.length;
        }
      }
      return res.status(200).json({ week: monday, outstanding: total, areas: out });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad_json" }); }
    }
    const incoming = Array.isArray(body && body.tasks) ? body.tasks : [body];
    if (!incoming.length) return res.status(400).json({ error: "nothing_to_add" });

    const cleaned = [];
    for (const entry of incoming) {
      const t = normalise(entry);
      if (t.error) return res.status(400).json({ error: t.error });
      cleaned.push(t);
    }

    // Read-modify-write. Fine for one person; it would need a lease if the
    // ledger were ever shared.
    if (!state.weekly || typeof state.weekly !== "object") state.weekly = {};
    if (!state.weeklyWeek) state.weeklyWeek = monday;

    const added = [];
    for (const { area, text } of cleaned) {
      if (!Array.isArray(state.weekly[area])) state.weekly[area] = [];
      if (state.weekly[area].length >= MAX_PER_AREA) {
        return res.status(409).json({ error: "area_full", area, limit: MAX_PER_AREA });
      }
      // Adding the same thing twice from an automation is a mistake, not intent.
      const dupe = state.weekly[area].some(
        (t) => !t.done && String(t.text).toLowerCase() === text.toLowerCase()
      );
      if (dupe) continue;
      const task = { id: "w-" + Math.random().toString(36).slice(2, 9), text, done: false, via: "api" };
      state.weekly[area].push(task);
      added.push({ area, text });
    }

    state.updatedAt = Date.now();
    await redis(["SET", STATE_DOC, JSON.stringify(state)]);

    return res.status(200).json({
      ok: true,
      added: added.length,
      skippedAsDuplicate: cleaned.length - added.length,
      tasks: added,
    });
  } catch (err) {
    return res.status(502).json({ error: "task_failed", detail: String(err.message || err) });
  }
}
