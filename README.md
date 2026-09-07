# Iron Ledger

A training and household accountability tracker for a home setup: kettlebells,
a push-up board and a skipping rope. It is deliberately blunt — it names skipped
sessions and overdue jobs, and keeps an honest count of both.

## Where it runs

The app is published as a Claude Artifact:

**https://claude.ai/code/artifact/250d7886-534d-47d2-bee5-f9e2634f72bf**

`iron-ledger.html` in this repo is the source. Publishing sends it to that URL.
The published page is wrapped in a minimal `<!doctype html><head>` skeleton at
publish time, which is why this file has no doctype, `<html>`, `<head>` or
`<body>` tags of its own — do not add them.

## What's in it

- **The programme** — five sessions sit on the plan (Mon Swing, Tue Wind,
  Thu Pull, Fri Press, Sat Grinder; Wed and Sun rest), on eight-week
  progression blocks. The **weekly target** (`state.target`, default 3) is what
  actually counts — adherence research is clear that people asked for six
  sessions a week stick worst and people asked for two stick best, so the week
  is the unit that passes or fails, not the day.
- **Rolling 28-day consistency** — the headline number, in place of a fragile
  streak. Streak anxiety is the single biggest cause of habit-app abandonment;
  a percentage over a window is dented by a miss rather than destroyed.
- **Never miss twice** — the one rule the app enforces. One skipped session is
  noise; two in a row triggers the loudest state in the app.
- **The nag** — a verdict panel keyed to the working day (at work, commute,
  the window, late, last call, day gone) and to how long since the last session.
- **The short version** — a half-length session offered when it's late. It
  counts and keeps the streak, but is tracked separately and called out when
  it becomes the habit.
- **Form guide** — 22 movements, each with set-up, execution and the one fault
  that catches most people.
- **Excuse ledger** — every skip must be named, and the count is kept.
- **The house** — room and laundry jobs tracked by days-since against an
  interval, not by streak. Fully editable in the app.

## State

Persisted through the Artifact `db` capability at `tracker/state`, with a
`localStorage` fallback keyed `iron-ledger-v2`. Shape:

```
{ start, done: {"YYYY-MM-DD": {key, at, express}}, skips: [{date, key, reason}],
  ticks: {}, longest, chores: [{id, name, every, last}] }
```

A scheduled task (`iron-ledger-nudge`, 18:00 daily) reads that document and
sends a status nudge. Changing the state shape means updating that task too.

## Previewing locally

```
python -m http.server 8765
```

Then open `http://localhost:8765/iron-ledger.html`. Note that Python serves no
charset, so em-dashes render as mojibake locally — the published version is
fine. To preview faithfully, prepend `<meta charset="utf-8">` to a scratch copy
(`_preview.html` is gitignored for this).
