/**
 * GET  /api/state  -> the stored ledger document, or null if nothing saved yet
 * PUT  /api/state  -> replace the stored ledger document
 *
 * Backed by Upstash Redis over its REST API, so this file has no dependencies
 * and there is no node_modules to keep alive. The Vercel "Upstash for Redis"
 * integration sets KV_REST_API_URL / KV_REST_API_TOKEN automatically; the
 * UPSTASH_* names are accepted too for a store connected by hand.
 *
 * Auth is a single shared secret in LEDGER_KEY, sent as the x-ledger-key
 * header. This is a one-person app: the secret is the whole access model, so
 * make it long and random. Anyone holding it can read and overwrite the record.
 */

const STORE_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const STORE_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const LEDGER_KEY = process.env.LEDGER_KEY;

const DOC = "iron-ledger:state";

async function redis(command) {
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

/** Constant-time-ish compare so the secret can't be probed a byte at a time. */
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!STORE_URL || !STORE_TOKEN) {
    return res.status(503).json({
      error: "storage_not_configured",
      message:
        "No Redis store is connected. Add the Upstash for Redis integration in the Vercel dashboard and redeploy.",
    });
  }
  if (!LEDGER_KEY) {
    return res.status(503).json({
      error: "key_not_configured",
      message: "Set the LEDGER_KEY environment variable in Vercel and redeploy.",
    });
  }
  if (!sameSecret(req.headers["x-ledger-key"], LEDGER_KEY)) {
    return res.status(401).json({ error: "bad_key" });
  }

  try {
    if (req.method === "GET") {
      const out = await redis(["GET", DOC]);
      const raw = out && out.result;
      return res.status(200).json(raw ? JSON.parse(raw) : null);
    }

    if (req.method === "PUT" || req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch (e) {
          return res.status(400).json({ error: "bad_json" });
        }
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "bad_body" });
      }
      await redis(["SET", DOC, JSON.stringify(body)]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    return res
      .status(502)
      .json({ error: "store_unavailable", detail: String(err.message || err) });
  }
}
