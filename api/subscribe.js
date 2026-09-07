/**
 * POST   /api/subscribe  { subscription }  -> register this device for pushes
 * DELETE /api/subscribe  { endpoint }      -> unregister it
 *
 * Gated by the same LEDGER_KEY as the record, so nobody else can attach a
 * device to these notifications.
 */
import { redis, sameSecret, storeConfigured, SUBS_HASH } from "./_lib.js";

const LEDGER_KEY = process.env.LEDGER_KEY;

/** Stable, short field name for a subscription endpoint. */
async function fieldFor(endpoint) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(endpoint)
  );
  return Array.from(new Uint8Array(buf).slice(0, 12))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!storeConfigured()) return res.status(503).json({ error: "storage_not_configured" });
  if (!LEDGER_KEY) return res.status(503).json({ error: "key_not_configured" });
  if (!sameSecret(req.headers["x-ledger-key"], LEDGER_KEY)) {
    return res.status(401).json({ error: "bad_key" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad_json" }); }
  }

  try {
    if (req.method === "POST") {
      const sub = body && body.subscription;
      if (!sub || typeof sub.endpoint !== "string" || !sub.keys) {
        return res.status(400).json({ error: "bad_subscription" });
      }
      const field = await fieldFor(sub.endpoint);
      await redis(["HSET", SUBS_HASH, field, JSON.stringify(sub)]);
      const count = await redis(["HLEN", SUBS_HASH]);
      return res.status(200).json({ ok: true, devices: count.result ?? null });
    }

    if (req.method === "DELETE") {
      const endpoint = body && body.endpoint;
      if (typeof endpoint !== "string") return res.status(400).json({ error: "bad_endpoint" });
      await redis(["HDEL", SUBS_HASH, await fieldFor(endpoint)]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "GET") {
      const count = await redis(["HLEN", SUBS_HASH]);
      return res.status(200).json({ devices: count.result ?? 0 });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    return res.status(502).json({ error: "store_unavailable", detail: String(err.message || err) });
  }
}
