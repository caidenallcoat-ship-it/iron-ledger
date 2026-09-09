# Getting things into the ledger from other apps

Apple's Reminders and Calendar have no web API — a web app on your phone
cannot read them, and no amount of building here changes that. What *can*
reach in is anything able to make an HTTP request, which on iOS means
**Shortcuts**, and by extension Siri and personal automations.

So the ledger exposes one endpoint and lets Shortcuts do the fetching.

## The endpoint

```
POST https://iron-ledger-cade10.vercel.app/api/task
Header:  x-ledger-key: <your key>
Body:    {"area": "house", "text": "Take the bins out"}
```

`area` is one of `house`, `train`, `eat`, `money`, `sleep`, `people`.
Anything else is refused with a message naming the valid ones.

Several at once:

```json
{"tasks": [
  {"area": "house",  "text": "Bin bags"},
  {"area": "people", "text": "Ring Mum"}
]}
```

Adding the same open task twice does nothing — an automation repeating itself
is a mistake, not intent. The response says how many were added and how many
were skipped as duplicates.

To read what is still outstanding:

```
GET https://iron-ledger-cade10.vercel.app/api/task
Header:  x-ledger-key: <your key>
```

```json
{ "week": "2026-09-08", "outstanding": 3,
  "areas": { "house": [{"text": "Bin bags", "carried": 0}] } }
```

`carried` is how many weeks that task has survived without being done.

## Shortcut 1 — add a task by voice

1. Shortcuts → **+** → Add Action → **Get Contents of URL**
2. URL: `https://iron-ledger-cade10.vercel.app/api/task`
3. Method: **POST**
4. Headers: `x-ledger-key` = your key
5. Request Body: **JSON**
   - `area` (Text) → `house`
   - `text` (Text) → **Shortcut Input**, or an **Ask for Input** action
6. Name it *"Add to the ledger"*

Then: *"Hey Siri, add to the ledger"* → it asks what, and it lands in the app.

## Shortcut 2 — push your Reminders in each Monday

1. **Find Reminders** — filter to the list you want, and *Is Completed* → false
2. **Repeat with Each**
3. Inside the loop, the same **Get Contents of URL** action as above, with
   `text` set to *Repeat Item → Name*
4. Automation → **Time of Day** → Monday 08:00 → run it without asking

Now whatever is sitting in Reminders becomes this week's tasks, and the
carried-over count starts telling you which ones you keep not doing.

## Shortcut 3 — read the outstanding list back

**Get Contents of URL** (GET, same header) → **Get Dictionary Value** for
`outstanding` → **Show Result**. Useful on a home-screen widget or as a Siri
phrase: *"what's outstanding?"*

## Your key

It is the `LEDGER_KEY` environment variable in Vercel, the same one the app
asks for. Anyone holding it can read and write your record, so keep the
Shortcut private and don't share it.

Ten wrong keys from one address buys a 15-minute lockout, so a misconfigured
Shortcut will stop itself rather than hammer the endpoint.

## What this deliberately does not do

No OAuth to Google, no calendar sync, no background polling. Each of those
means handing a third party standing access to your data to save a tap, and
an integration that breaks silently six months later. A Shortcut you can read
in full, that runs when you say so, is a better trade for one person's
training log.

## Apple Health

Health has no web API and never will — HealthKit is native only, so this page
cannot read a single sample from it however it is asked. Shortcuts can, and
Shortcuts can make an HTTP request, so that is the whole bridge.

```
POST https://iron-ledger-cade10.vercel.app/api/health
Header:  x-ledger-key: <your key>
Body:    {"date": "2026-09-08", "sleep": {"asleepAt": "23:12", "hours": 7.4}}
```

`date` is optional and defaults to today. `asleepAt` takes `"23:12"`, a full
timestamp, or a plain number of hours. Anything after midnight is treated as
later than an 11pm target, not earlier — 01:30 is a late night, not an early
one.

The response says what it decided:

```json
{ "ok": true, "date": "2026-09-08", "asleepAt": 23.2,
  "target": 23, "onTime": false, "hours": 7.4 }
```

### Shortcut 4 — last night's sleep, every morning

1. **Find Health Samples** — Type: *Sleep Analysis*, Sort by *Start Date*,
   Limit 1, filtered to *Started* — *is today* (or yesterday, whichever your
   watch writes)
2. **Get Details of Health Sample** → *Start Date* → that is `asleepAt`
3. **Get Contents of URL** — POST to `/api/health`, header `x-ledger-key`,
   Request Body **JSON**:
   - `date` (Text) → the sleep sample's start date formatted `yyyy-MM-dd`
   - `sleep` (Dictionary) → `asleepAt` = the start date
4. Automation → **Time of Day** → 09:00 daily → run without asking

The sleep tick in the app then looks after itself. It is the one thing the
ledger asks you to record that your phone already knows.

### Shortcut 5 — write your session into Health

Kettlebells do not show up in the Fitness app on their own. This puts them
there, so your rings and Iron Ledger stop disagreeing.

1. **Get Contents of URL** — GET `/api/health` with the key header
2. **Get Dictionary Value** → `trained`
3. **If** it is `1`:
   - **Get Dictionary Value** → `minutes`
   - **Log Health Sample** → *Workout* → *Functional Strength Training*,
     duration from that value
4. Automation → **Time of Day** → 21:30 daily

`/api/health` also returns `restDay`, so a Shortcut can leave you alone on a
day you have already paid for.

### What is deliberately not here

No weight, no steps, no heart rate. All of them are easy to accept and none of
them are read by anything in the app, so they would be numbers collected for
the sake of collecting numbers. Sleep is here because the app already scores
it and already asks you to tick it by hand.

## Your calendar

Calendar has no web API either. Shortcuts reads it, so it is the same bridge
as Health — and the useful thing to send is not your appointments, only which
evenings are already gone.

```
POST https://iron-ledger-cade10.vercel.app/api/plan
Header:  x-ledger-key: <your key>
Body:    {"busy": [
           {"date": "2026-09-11", "what": "Five-a-side"},
           {"date": "2026-09-12"}
         ]}
```

`what` is optional and only used to name the evening back to you. Dates
outside the next fortnight are ignored, and each post **replaces** everything
already stored inside that window — a calendar is the authority on its own
dates, so an event you cancelled clears itself instead of haunting the app.

To read the week back:

```
GET https://iron-ledger-cade10.vercel.app/api/plan
```

```json
{ "week": "2026-09-07", "target": 3, "trained": 2, "free": 3,
  "busy": [{"date": "2026-09-11", "what": "Five-a-side"}] }
```

### Shortcut 6 — push the week's evenings in, every morning

1. **Find Calendar Events** — *Start Date* is in the next 7 days, and
   *Start Date* is after 17:00 (add a second filter for before 22:00 if your
   days are busy in the afternoon)
2. **Repeat with Each**, building a dictionary of `date` and `what` from
   *Repeat Item → Start Date* and *→ Title*
3. **Get Contents of URL** — POST the list to `/api/plan`
4. Automation → **Time of Day** → 07:00 daily → run without asking

### What it changes, and what it deliberately doesn't

A booked evening **never lowers the target**. Three sessions is still three
sessions — life filling up is a reason to start earlier in the week, not a
reason to owe less, and a calendar that excused sessions would just be a way
of writing the week off in advance.

What it changes is *when the app starts pushing* and *what it says on the
night*. Three sessions across five free evenings is comfortable; across two
it is already in trouble, and the app used to treat those identically. Now:

- "Week at risk" counts free evenings rather than days on a calendar
- On a booked evening it says **"Tonight is spoken for — Mum's birthday"**
  rather than nagging about a session that cannot happen
- The 18:00 notification does the same, and tells you how many free evenings
  are left for what you still owe
- The day shows on the grid as a dashed outline: not trained, not missed

### Shortcut 7 — block the session out in your calendar

The reverse direction, and worth doing: **Add New Event**, 30 minutes at your
training time, on the days you intend to train. Deciding when in advance is
the single best-evidenced trick for actually doing it, and an evening already
blocked out is one nobody else can book.

## Logging the session itself

Until now everything here could *read* training and nothing could record it,
which meant the one thing the app is about was the one thing an automation
couldn't touch.

```
POST   https://iron-ledger-cade10.vercel.app/api/session
Header: x-ledger-key: <your key>
Body:   {}                                  -> logs today
        {"express": true}                   -> the short version
        {"note": "24kg felt heavy"}         -> with a note
        {"date": "2026-09-08"}              -> backfill a day you forgot

DELETE  same URL                            -> unlog it
GET     same URL                            -> what's next, without logging it
```

You cannot tell it *which* session to log. The programme is a rotating queue,
so which one comes next is a fact about the record, not something an
automation gets to assert. Logging the same day twice is refused with a 409
rather than silently overwriting — an automation firing twice is a mistake,
not two sessions.

### Shortcut 8 — "Hey Siri, log my session"

**Get Contents of URL** → POST to `/api/session`, key header, empty JSON body
→ **Get Dictionary Value** for `thisWeek` → **Show Result**. Name it *"Log my
session"*. Siri answers with how many you've done this week.

### Shortcut 9 — let the Watch do it

The proper version. Apple Watch → **Personal Automation** → *Workout* → *When
I finish* a **Functional Strength Training** workout → run the POST above.
Finish the session, end the workout on your wrist, and the ledger already
knows before you've put the bell down.

Pair it with Shortcut 5 and the two directions close a loop: your kettlebell
work shows up in Fitness, and finishing it marks the week here.

## Weight

Accepted now that something reads it — the eating panel shows a **four-week
direction**, never a daily number.

```
POST /api/health   {"weight": 84.2}
```

**Find Health Samples** → *Weight*, latest 1 → POST it. Weekly is plenty;
daily is noise, and watching a scale move day to day is a well-known way of
talking yourself out of something that is working.

The panel reads: *"2.2 kg down over 28 days. 83.9 kg now, from 86.1. A
direction, not a verdict — one weigh-in means nothing."* With fewer than two
readings in the window it says nothing at all.

## A home-screen widget

Shortcuts can't draw one, but **Scriptable** (free, App Store) can, and
`/api/session` and `/api/plan` return everything a widget needs. A small
script fetching both gives you *"2 of 3 · 3 free evenings · Session C next"*
on your home screen without opening anything.

## What is still manual, and what could stop being

**Spending.** It is the only thing left that you have to type in by hand.
Monzo and Starling both have real APIs with transaction webhooks — a proper
live integration rather than a Shortcut, where the ledger would learn about
a purchase as it happens. It needs OAuth and a stored token, so it is a
genuine piece of work rather than a recipe, and it only makes sense if you
bank with one of them. Worth asking for if you do.

**Google Calendar and Gmail** have web APIs too, so the calendar side could
be live rather than a 7am Shortcut. Same trade: OAuth, a token to keep, and
a third party with standing access to your data. The Shortcut runs when you
say so and can be read in full, which for one person's training log is the
better bargain.
