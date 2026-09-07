# Deploying Iron Ledger to Vercel

The result is a real web app on your own domain: installable, offline-capable,
no claude.ai sign-in, and syncing across devices through your own database.

Takes about ten minutes, most of it waiting.

## 1. Install the Vercel CLI and log in

```
npm i -g vercel
vercel login
```

## 2. Deploy once, to create the project

From this folder:

```
npm run build
vercel
```

Accept the defaults. It will detect a static site with serverless functions —
`public/` is served, `api/state.js` becomes `/api/state`. The first deploy will
work but the app will say *"Server reached, but not set up yet"*, because there
is no database and no key. That's expected; the next two steps fix it.

## 3. Connect a database

In the Vercel dashboard: **Storage → Marketplace → Upstash for Redis → connect
to this project.** The free tier is far more than this needs.

Connecting it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
`api/state.js` reads either those or the `UPSTASH_REDIS_REST_*` names, so a
store connected by hand works too.

## 4. Set your key

**Settings → Environment Variables**, add:

```
LEDGER_KEY = <a long random string>
```

Generate one with:

```
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

This single secret is the entire access model. Anyone who has it can read and
overwrite your record — so don't paste it anywhere public, and don't use a
short one. It is never committed: it lives only in Vercel and in your browser's
local storage.

## 5. Redeploy and unlock

```
vercel --prod
```

Open the URL. It will ask for the key once, then remember it on that device.
Do the same on your phone, then **Share → Add to Home Screen**.

## Afterwards

- **Deploying changes:** `npm run build && vercel --prod`. Always build first —
  `public/index.html` is generated from `iron-ledger.html` and is not the file
  you edit.
- **The scheduled nudge** reads the record directly. Once this is live it must
  be pointed at `https://<your-domain>/api/state` with the `x-ledger-key`
  header, instead of the artifact database. Ask Claude to switch it over and
  give it the domain — the key stays in Vercel, the task gets told where to
  find it.
- **The artifact** at
  https://claude.ai/code/artifact/250d7886-534d-47d2-bee5-f9e2634f72bf
  keeps working, but it has its **own separate database**. Once you're on
  Vercel, pick one and stop opening the other, or you'll end up with two
  half-records — which is exactly the mess this project already cleaned up once.

## Migrating your existing record

If you've logged anything in the artifact before switching, ask Claude to read
`tracker/state` from the artifact database and `PUT` it to your new
`/api/state`. Nothing is lost as long as it happens before you start logging in
both places.
