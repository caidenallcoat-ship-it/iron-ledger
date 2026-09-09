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

import {
  redis, authorise,
  STATE_DOC as DOC,
} from "./_lib.js";


export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const auth = await authorise(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

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
