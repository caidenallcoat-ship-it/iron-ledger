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
