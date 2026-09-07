# Iron Ledger — working notes

## The one rule

There is exactly ONE tracker. Do not create a second artifact, a habit tracker,
or a separate chore app. A duplicate was built by accident on 2026-09-07 by a
parallel session and had to be merged back in by hand. New areas of life go in
as another section of this file.

## Two deployments, one source

`iron-ledger.html` is the ONLY file you edit. It is the app body with no
doctype/head/body tags, because both targets supply their own:

- **Vercel (the live app)** — https://iron-ledger-cade10.vercel.app
  Deploys automatically on push to `main`; Vercel runs the build itself.
  `npx vercel deploy --prod --yes` still works for an uncommitted change.
  Always run `npm run build` before committing so the generated
  `public/index.html` in the repo matches the source.
- **Artifact** — RETIRED. The old artifact URL now shows a "moved" notice
  (`artifact-moved.html`). Do not publish the app there again.
- **Vercel** — `npm run build` wraps it into `public/index.html` with the PWA
  head (manifest, icons, theme colours, service worker). `public/index.html` is
  generated and gitignored; never edit it.

Storage is chosen at runtime by `Store` in the script: the Artifact database
when `window.claude` exists, else `/api/state` (see `api/state.js`), else
localStorage. Adding a field means checking all three paths still work.

See DEPLOY.md for the Vercel setup.

## Publishing

Publish `iron-ledger.html` to the existing artifact:

    Artifact tool, url: https://claude.ai/code/artifact/250d7886-534d-47d2-bee5-f9e2634f72bf

Read the artifact before publishing to it. Never publish without `url` — that
creates a new artifact instead of updating this one.

The publish wrapper supplies the doctype, `<head>`, charset and viewport. This
file must not contain `<!DOCTYPE>`, `<html>`, `<head>` or `<body>` tags.

## Tone

Blunt and factual. Name skipped sessions and overdue jobs directly, with real
counts. Never shouty, never mocking, never cheerleading. This is Caiden's
explicit choice — do not soften it.

## Constraints

- Home kit only: kettlebells, push-up board, skipping rope. No gym, no barbell.
- Works 9-5, home ~18:00, trains 18:30, hard stop 22:00. The nag copy depends
  on this; `DAY` at the top of the script holds it.
- Chores are a clock, not a streak: report days-since against an interval.
  Never convert them to a streak mechanic.

## Gotchas

- Dates are local, never UTC. Use the `key()` / `parseKey()` helpers.
- The minute-tick `setInterval` re-renders everything; it deliberately skips
  while a job edit form is open so typing isn't destroyed.
- `state.chores === null` means "seed the defaults" — that's how existing saved
  records migrate forward. Keep that check when changing the shape.
- Changing the state shape breaks the `iron-ledger-nudge` scheduled task, which
  reads `tracker/state` directly. Update its prompt in the same change.
