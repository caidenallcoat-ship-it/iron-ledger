/**
 * The 18:00 nudge.
 *
 * Called by Vercel Cron. Vercel Cron only speaks UTC, and the UK moves between
 * GMT and BST, so this is scheduled to fire at both 17:00 and 18:00 UTC and
 * only actually sends when it is NUDGE_HOUR in Europe/London. That way the
 * notification lands at the same local time all year without touching the
 * schedule in October.
 *
 * Auth: Vercel sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is
 * set. A manual run with the x-ledger-key header is also allowed, for testing.
 */
import webpush from "web-push";
import { listUsers, loadFor, subsDoc } from "./_users.js";
import {
  redis, sameSecret, storeConfigured, buildNudge, localParts,
} from "./_lib.js";

const LEDGER_KEY = process.env.LEDGER_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:nobody@example.com";
const TZ = process.env.NUDGE_TZ || "Europe/London";
const HOUR = Number(process.env.NUDGE_HOUR || 18);

/* The hour to nudge at, taken from the training time you set in the app: the
   top of the hour containing half an hour before you start. 18:30 nudges at
   18:00, 19:30 at 19:00. Reading it from the record means changing your slot
   in the app moves the notification, instead of leaving it firing ninety
   minutes early forever.

   Which UTC hours can fire at all is fixed by the cron entries in
   vercel.json, so a slot outside that window needs those changing too — the
   app says so rather than going quiet. */
export function nudgeHourFor(state) {
  const raw = state && state.slot;
  /* Number(null) is 0, which is a perfectly valid hour and would have sent
     the nudge at midnight for any record that hasn't set a slot yet. */
  if (raw === null || raw === undefined || raw === "") return HOUR;
  const slot = Number(raw);
  if (!Number.isFinite(slot) || slot < 0.5 || slot > 23.99) return HOUR;
  return Math.max(0, Math.min(23, Math.floor(slot - 0.5)));
}
const APP_URL = process.env.APP_URL || "https://iron-ledger-cade10.vercel.app";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const auth = req.headers.authorization || "";
  const byCron = CRON_SECRET && sameSecret(auth, "Bearer " + CRON_SECRET);
  const byHand = LEDGER_KEY && sameSecret(req.headers["x-ledger-key"], LEDGER_KEY);
  if (!byCron && !byHand) return res.status(401).json({ error: "unauthorized" });

  if (!storeConfigured()) return res.status(503).json({ error: "storage_not_configured" });
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(503).json({ error: "vapid_not_configured" });
  }

  const now = localParts(TZ);
  const force = "force" in (req.query || {});

  try {
    /* One cron run, everybody's evening. Each person has their own training
       time, so the hour is asked of each record rather than of the deploy —
       two people training at seven and half eight are two different jobs that
       happen to share a schedule. */
    const people = await listUsers();
    if (!people.length) {
      return res.status(200).json({ sent: 0, reason: "no_users" });
    }

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

    const report = [];
    let sentTotal = 0, prunedTotal = 0;

    for (const person of people) {
      const state = await loadFor(person.uid);
      if (!state) { report.push({ name: person.name, skipped: "no_record" }); continue; }

      const wanted = nudgeHourFor(state);
      if (byCron && !force && now.hour !== wanted) {
        report.push({ name: person.name, skipped: "wrong_local_hour", wanted });
        continue;
      }

      const nudge = buildNudge(state, now.key);
      if (!nudge) { report.push({ name: person.name, skipped: "nothing_worth_saying" }); continue; }

      const all = await redis(["HGETALL", subsDoc(person.uid)]);
      const flat = (all && all.result) || [];
      const subs = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        try { subs.push({ field: flat[i], sub: JSON.parse(flat[i + 1]) }); } catch {}
      }
      if (!subs.length) { report.push({ name: person.name, skipped: "no_devices", nudge }); continue; }

      const payload = JSON.stringify({ ...nudge, url: APP_URL });
      let sent = 0;
      const dead = [];
      await Promise.all(subs.map(async ({ field, sub }) => {
        try { await webpush.sendNotification(sub, payload); sent++; }
        catch (err) {
          // 404/410 mean the browser threw the subscription away.
          if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.push(field);
        }
      }));
      if (dead.length) await redis(["HDEL", subsDoc(person.uid), ...dead]);

      sentTotal += sent;
      prunedTotal += dead.length;
      report.push({ name: person.name, sent, pruned: dead.length, nudge });
    }

    return res.status(200).json({
      sent: sentTotal, pruned: prunedTotal, date: now.key, localHour: now.hour, people: report,
    });
  } catch (err) {
    return res.status(502).json({ error: "notify_failed", detail: String(err.message || err) });
  }
}
