# Iron Ledger — working notes

## The one rule

There is exactly ONE tracker. Do not create a second artifact, a habit tracker,
or a separate chore app. A duplicate was built by accident on 2026-09-07 by a
parallel session and had to be merged back in by hand. New areas of life go in
as another section of this file.

## Publishing

`iron-ledger.html` is the source of truth. Publish it to the existing artifact:

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
