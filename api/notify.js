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
import {
  redis, sameSecret, storeConfigured, loadState, buildNudge, localParts, SUBS_HASH,
} from "./_lib.js";

const LEDGER_KEY = process.env.LEDGER_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:nobody@example.com";
const TZ = process.env.NUDGE_TZ || "Europe/London";
const HOUR = Number(process.env.NUDGE_HOUR || 18);
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

  // The DST guard. A manual run can skip it.
  if (byCron && !force && now.hour !== HOUR) {
    return res.status(200).json({ skipped: "wrong_local_hour", localHour: now.hour, wanted: HOUR });
  }

  try {
    const state = await loadState();
    const nudge = buildNudge(state, now.key);
    if (!nudge) {
      return res.status(200).json({ sent: 0, reason: "nothing_worth_saying", date: now.key });
    }

    const all = await redis(["HGETALL", SUBS_HASH]);
    // Upstash returns HGETALL as a flat [field, value, field, value, ...].
    const flat = all.result || [];
    const subs = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      try { subs.push({ field: flat[i], sub: JSON.parse(flat[i + 1]) }); } catch {}
    }
    if (!subs.length) {
      return res.status(200).json({ sent: 0, reason: "no_devices", nudge });
    }

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    const payload = JSON.stringify({ ...nudge, url: APP_URL });

    let sent = 0;
    const dead = [];
    await Promise.all(subs.map(async ({ field, sub }) => {
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
      } catch (err) {
        // 404/410 mean the browser threw the subscription away — stop trying.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.push(field);
      }
    }));

    if (dead.length) await redis(["HDEL", SUBS_HASH, ...dead]);

    return res.status(200).json({ sent, pruned: dead.length, nudge, date: now.key });
  } catch (err) {
    return res.status(502).json({ error: "notify_failed", detail: String(err.message || err) });
  }
}
