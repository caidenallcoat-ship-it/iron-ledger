/**
 * GET    /api/people            -> who is on this ledger
 * POST   /api/people {name}     -> add someone, returns their key ONCE
 * DELETE /api/people {uid}      -> remove someone and their record
 *
 * Owner only. Whoever holds LEDGER_KEY is the owner; everyone else can use
 * the app and see who else is on it, but cannot mint keys or delete anyone.
 *
 * The key is shown exactly once, at creation, because only its hash is
 * stored. If it is lost the person gets a new one — there is nothing to
 * recover, which is the point.
 */
import { authorise } from "./_lib.js";
import { listUsers, userInfo, createUser, removeUser, loadFor } from "./_users.js";

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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const auth = await authorise(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const me = await userInfo(auth.uid);
  const isOwner = Boolean(me && me.admin);

  try {
    if (req.method === "GET") {
      /* Everyone can see the week everyone else has had. That is the whole
         reason for putting two people on one ledger rather than two copies of
         the app — a training log nobody else can see is a diary. Nothing else
         is shared: not weight, not money, not the house. */
      const { localParts } = await import("./_lib.js");
      const today = localParts().key;
      const monday = mondayOf(today);
      const people = await listUsers();
      const rows = [];
      for (const p of people) {
        const s = await loadFor(p.uid);
        let trained = 0, target = 3;
        if (s) {
          target = Number(s.target) >= 1 && Number(s.target) <= 7 ? Number(s.target) : 3;
          for (let i = 0; i < 7; i++) if ((s.done || {})[addDays(monday, i)]) trained++;
        }
        rows.push({
          uid: p.uid, name: p.name, owner: Boolean(p.admin),
          you: p.uid === auth.uid,
          trained, target, met: trained >= target,
          started: s ? s.start : null,
        });
      }
      rows.sort((a, b) => (b.trained - a.trained) || a.name.localeCompare(b.name));
      return res.status(200).json({ week: monday, people: rows });
    }

    if (!isOwner) return res.status(403).json({ error: "owner_only" });

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad_json" }); }
    }
    body = body || {};

    if (req.method === "POST") {
      const name = String(body.name || "").trim().slice(0, 40);
      if (!name) return res.status(400).json({ error: "name_required" });
      const people = await listUsers();
      if (people.length >= 10) return res.status(409).json({ error: "too_many_people" });
      if (people.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        return res.status(409).json({ error: "name_taken" });
      }
      const made = await createUser(name);
      return res.status(200).json({
        ok: true, uid: made.uid, name: made.name, key: made.key,
        note: "This key is shown once and nowhere else. Send it to them and don't keep a copy.",
      });
    }

    if (req.method === "DELETE") {
      const uid = String(body.uid || "");
      if (!uid) return res.status(400).json({ error: "uid_required" });
      if (uid === auth.uid) return res.status(400).json({ error: "cannot_remove_yourself" });
      const gone = await removeUser(uid);
      if (!gone) return res.status(404).json({ error: "not_found_or_owner" });
      return res.status(200).json({ ok: true, removed: uid });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    return res.status(502).json({ error: "people_failed", detail: String(err.message || err) });
  }
}
