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

import { authorise } from "./_lib.js";
import { loadFor, saveFor, userInfo } from "./_users.js";
import { merge3 } from "./_merge.js";


export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const auth = await authorise(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  try {
    if (req.method === "GET") {
      return res.status(200).json(await loadFor(auth.uid));
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
      /* The app sends the version it last synced with alongside its copy.
         If the server has moved on since — a Shortcut logged a session,
         Health wrote sleep — the two are merged rather than the app's copy
         being saved over the top. See _merge.js. An app that sends no base
         (an old build still cached on a phone) is saved as before. */
      const base = body._base && typeof body._base === "object" ? body._base : null;
      delete body._base;
      delete body.baseUpdatedAt;
      let toSave = body, merged = false;
      if (base) {
        const current = await loadFor(auth.uid);
        if (current && current.updatedAt !== base.updatedAt) {
          toSave = merge3(base, body, current);
          merged = true;
        }
      }
      const saved = await saveFor(auth.uid, toSave);
      const who = await userInfo(auth.uid);
      return res.status(200).json({ ok: true, merged, state: saved, name: who ? who.name : null });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    return res
      .status(502)
      .json({ error: "store_unavailable", detail: String(err.message || err) });
  }
}
