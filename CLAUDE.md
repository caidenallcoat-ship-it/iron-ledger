# Iron Ledger — working notes

## The one rule

There is exactly ONE tracker. Do not create a second artifact, a habit tracker,
or a separate chore app. A duplicate was built by accident on 2026-09-07 by a
parallel session and had to be merged back in by hand. New areas of life go in
as another section of this file.

## One deployment, one source

`iron-ledger.html` is the ONLY app file you edit. It has no
doctype/head/body tags; `build.mjs` supplies them.

- **Vercel (the live app)** — https://iron-ledger-cade10.vercel.app
  Deploys automatically on push to `main`; Vercel runs the build itself.
  `npx vercel deploy --prod --yes` still works for an uncommitted change.
- `npm run build` wraps the source into `public/index.html` with the PWA head
  (manifest, icons, theme colours, service worker), and writes
  `public/version.json` and `public/widget.js`. All three are generated but
  COMMITTED — run the build before every commit so they match the source,
  and never edit them by hand.
- **The Claude Artifact is RETIRED.** Its URL shows a "moved" notice
  (`artifact-moved.html`). Never publish the app there, and ignore anything
  that suggests otherwise.

Storage is chosen at runtime by `Store` in the script: the Artifact database
if `window.claude` exists (legacy, unused), else `/api/state`, else
localStorage. In practice it is always `/api/state`.

See DEPLOY.md for the Vercel setup.

## Two people, not one

Since 2026-09-09 this is a multi-user ledger. Each person has their own long
random key; only its SHA-256 is stored, and the key IS the identity — there
are no passwords and no accounts.

- `iron-ledger:u:<uid>` is a person's record, `iron-ledger:k:<hash>` maps a
  key to them, `iron-ledger:users` is the roster, `iron-ledger:subs:<uid>`
  their devices.
- The owner is whoever holds `LEDGER_KEY` (Caiden). Only the owner can add or
  remove people, via `/api/people`.
- Everyone sees everyone's WEEK and nothing else. Weight, money, sleep, the
  house and rewards are private. There is a test asserting that; do not widen
  what is shared without a reason.
- `loadFor(uid)` / `saveFor(uid, state)` — never read or write
  `iron-ledger:state` directly again. It is kept mirrored for rollback only.
- Anything in `api/` becomes a serverless function, tests included, and they
  count against the plan's function limit. `.vercelignore` excludes
  `api/*.test.mjs`; keep it that way or deploys fail with a bare "Error".

## Saving is a merge, not an overwrite

Several things write the same record: the app, and — straight to the server —
the Watch (`/api/session`), Health (`/api/health`), the calendar
(`/api/plan`), Siri and Reminders (`/api/task`, `/api/spend`).

- The app keeps the server version it last synced with (`base`, in
  localStorage) and sends it as `_base` with every PUT. If the server has moved
  on, `api/state.js` merges three ways with `api/_merge.js`. Do not go back to
  saving the app's copy over the top: that silently erased Shortcut writes.
- Anything that writes the record server-side must follow the same rules the
  app does. `/api/task` rolls the week itself (`rollWeek`) for exactly this
  reason. If you add a rule to the app that changes stored data over time,
  check whether a server writer needs it too.
- `api/sync.test.mjs` holds the scenarios. Add one for any new writer.

## Whose life this is

The app was written around Caiden and assumed it everywhere. Two people use it
now, so nothing may hardcode one person's life:

- The name comes from the roster (`/api/people`), cached as
  `iron-ledger-name`. Never type a name into the markup.
- The shape of the day hangs off the person's own slot and `state.daytime` /
  `state.homeBy` (`dayShape()`), not fixed hours.
- Kit comes from `state.kit` and `state.bells`. No board means floor push-ups,
  no rope means marching; one bell means progression by reps, not load.
- An unanswered question must leave behaviour exactly as it was.
- Areas can be switched off (`state.tracking`, a list of the optional ones
  that are ON; unset means all six). Training can't be. Anything that reports
  on an area — the ring, the weekly review, the figures, the rewards list,
  `buildNudge` — must check `tracks(id)` (the server has its own `tracks`).
  Switching off hides; it never deletes what was logged.

## Tone

Blunt and factual. Name skipped sessions and overdue jobs directly, with real
counts. Never shouty, never mocking, never cheerleading. This is Caiden's
explicit choice — do not soften it.

## Constraints

- Home kit only. Caiden has a 6kg and an 8kg kettlebell, a push-up board and a rope;
  other people's kit is in their record. No gym, no barbell.
- Training time is `state.slot` in each person's record — Caiden's is 19:30.
  `DAY` at the top of the script only holds defaults for anything unset.
- A job or person nobody has logged yet starts its clock the day it went on
  the list (`clockFrom()`), never "infinitely overdue". Same rule server-side.
- Chores are a clock, not a streak: report days-since against an interval.
  Never convert them to a streak mechanic.
- Rank counts work done, and it CAN fall — but only after sustained absence.
  One empty week costs nothing; from the second consecutive empty week it
  erodes at twice your weekly target, and the first session back clears the penalty
  outright. The rule that matters is that a single miss must never cost
  anything: a streak resets to zero on one bad day and that is the mechanic
  this app exists to avoid. Slow erosion is not that, and a rank that only
  ever climbs eventually lies about what you can do.
- An earned rest day lowers the bar; it never fills the number in. The week
  still reports the sessions actually done ("2 of 3"), it just isn't judged
  short. `weekBar()` / `weekMet()` hold that distinction — use them for any
  pass/fail judgement and `weekTarget()` only for display.
- Rewards are earned one per FINISHED week (`perfectWeek()` — real sessions
  only, never rest days) and at most three are held at once. A week completed
  with a rest day must never earn a reward, or the mechanic funds itself.
  Everything is bought with training, whichever area it is spent on: never add
  a second currency.

## Gotchas

- Dates are local, never UTC. Use the `key()` / `parseKey()` helpers.
- The minute-tick `setInterval` re-renders everything; it deliberately skips
  while a job edit form is open so typing isn't destroyed. The clock is also
  read on `visibilitychange` (`tickClock()`): a phone suspends the app, and
  without that it showed yesterday for up to a minute after unlocking.
- Anything a render function wires up must be on an element that render
  created. `addEventListener` on a container that survives the render adds
  another listener every minute — this turned one tap into several sets
  twice. Use `onclick =` on persistent elements.
- Session mode must never delete what was logged. `finish()` and Stop both
  add ticks; neither removes a bell. Whether a bell counts as history is
  decided when it is read (only on days with a logged session).
- `state.chores === null` means "seed the defaults" — that's how existing saved
  records migrate forward. Keep that check when changing the shape.
- The evening notification is web push from `api/notify.js`, built by
  `buildNudge` in `api/_lib.js`, sent at each person's own hour. The old
  `iron-ledger-nudge` scheduled task is DISABLED and kept only as a fallback;
  its prompt describes an old record shape, so re-check it before re-enabling.
- `npm test` runs the server suites. `buildNudge` duplicates the app's week,
  rank and job rules — change either side and run it; add a case rather than
  loosening one. Tests that depend on the date must freeze `Date` itself, not
  just `Date.now` (two only passed on the day they were written).
- The app has no checked-in tests yet; every app check so far has been done
  by hand in the browser.
