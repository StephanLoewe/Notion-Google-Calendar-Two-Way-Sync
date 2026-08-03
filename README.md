# Notion ↔ Google Calendar two-way sync

A Google Apps Script that keeps a Notion database and Google Calendar in sync in
both directions. Edit a task in Notion and the calendar event follows; move an
event in Google Calendar and the Notion page follows.

This is a hardened fork of
[hk21702/YA-GCal-Notion-Sync-Script](https://github.com/hk21702/YA-GCal-Notion-Sync-Script),
rewritten to survive the failure modes that made the original fail
intermittently in daily use. See [What changed](#what-changed-compared-to-the-original)
for the full list.

---

## What it does

- **Notion → Google Calendar.** Pages edited in Notion are pushed to the
  calendar named in their `Calendar` property. New pages create events, edited
  pages update them, and pages tagged `Cancel and Remove` delete the event.
- **Google Calendar → Notion.** Events created, moved or cancelled in the
  calendar are written back to the matching Notion database, using incremental
  sync tokens so each run only looks at what actually changed.
- **Many calendars.** A `Calendar` select value maps to a Google calendar id, so
  one database can feed several calendars. Changing the value moves the event.
- **Many databases.** Each database is a *sync target* that owns a set of
  calendars — useful when private and work planning live in separate Notion
  databases.

### What it deliberately skips

| Skipped | Why |
| --- | --- |
| Recurring series and their occurrences | The Notion side has no recurrence model; syncing occurrences produces endless near-duplicates |
| All-day events coming *from* Google Calendar | Would flood the database with holidays and colleagues' out-of-office entries. All-day events pushed *from* Notion work fine |
| Events outside a sanity window (default −90 / +365 days) | Guards against far-future occurrences leaking in through an incremental sync |
| Pages tagged `Ignore Sync` | In both directions |

Every skip is logged with the reason, so the execution log tells you exactly
what was dropped and why.

---

## Requirements

- A Google account (Workspace or consumer) with Google Calendar
- A [Notion integration token](https://www.notion.so/my-integrations)
- Each database you sync must be **shared with that integration**
  (database → `···` → *Connections* → your integration)

## Notion database setup

Every synced database needs these properties, spelled exactly like this:

| Property | Type | Purpose |
| --- | --- | --- |
| `Name` | Title | Event title |
| `Do Date` | Date | Start, and optionally end. Date-only values become all-day events |
| `Tags` | Multi-select | Control tags, see below |
| `Location` | Text | Event location |
| `Description` | Text | Event description |
| `Event ID` | Text | Written by the script — do not edit |
| `Calendar` | Select | Which calendar the event belongs in. Options must match the keys in `targets.gs` |
| `Calendar ID` | Select | Written by the script — do not edit |
| `Last Sync` | Date | Written by the script — do not edit |

Two `Tags` values have meaning:

- **`Cancel and Remove`** — deletes the event from Google Calendar and archives
  the Notion page.
- **`Ignore Sync`** — excludes the page from syncing entirely, in both
  directions.

The property names are constants at the top of `code.gs`. Change them there if
your database uses different ones — but keep them identical across all synced
databases.

---

## Installation

1. **Create the Apps Script project** at [script.google.com](https://script.google.com).

2. **Enable the Calendar advanced service.** In the editor sidebar: *Services* →
   *Calendar API* → *Add*. Without this, `Calendar.Events.list` is undefined and
   nothing syncs.

3. **Add the files.** Copy `code.gs` into the project. Copy `targets.example.gs`
   into a second file named `targets.gs` and fill in your own ids.

   > `SYNC_TARGETS` must be declared in exactly one file. A duplicate `const`
   > breaks the entire project, not just the file it is in.

4. **Set the script property.** *Project Settings* → *Script Properties* → add
   `NOTION_TOKEN` with your integration token.

5. **Configure `targets.gs`:**

   ```javascript
   const SYNC_TARGETS = [
       {
           name: 'Planner',
           database_id: 'https://www.notion.so/your-workspace/0123456789abcdef...',
           calendars: {
               ['Tasks']:        'your-tasks-calendar-id@group.calendar.google.com',
               ['Joy / Energy']: 'your-energy-calendar-id@group.calendar.google.com',
               ['Family']:       'your-family-calendar-id@group.calendar.google.com',
           },
       },
       {
           name: 'Work',
           database_id: 'https://www.notion.so/your-workspace/fedcba9876543210...',
           calendars: {
               ['Jour Fixe']: 'your-work-calendar-id@group.calendar.google.com',
           },
       },
   ];
   ```

   `name` appears in log output only. `database_id` accepts the full Notion URL
   or the bare 32-character id. Calendar ids are in Google Calendar under
   *Settings* → *&lt;calendar&gt;* → *Integrate calendar*.

   **A database may own any number of calendars. A calendar must belong to
   exactly one database** — otherwise an event arriving from Google Calendar
   would have no deterministic database to be created in. This is checked at
   startup and reported with both target names and the offending calendar id.

6. **Verify the configuration.** Run `showConfiguration()` by hand. It prints
   every target with its calendars and confirms what the script actually sees.

7. **First sync.** Run `resetSyncTokens()`, then `fullSync()`, both by hand.
   Accept the authorization prompt when it appears.

8. **Add the trigger.** *Triggers* → *Add Trigger* → function `main`, time-driven,
   **every 5 minutes**.

   Every minute is a bad idea: Apps Script allows 90 minutes of total trigger
   runtime per day on consumer accounts (6 hours on Workspace). At 1440 runs a
   day you exhaust that budget; at 288 runs you use roughly half of it with
   room to spare.

---

## Manual functions

| Function | Purpose |
| --- | --- |
| `main()` | The regular sync. This is what the trigger calls |
| `showConfiguration()` | Prints the resolved targets and calendars. Run after editing `targets.gs` |
| `fullSync()` | Ignores sync tokens and re-reads the whole time window |
| `resetSyncTokens()` | Deletes all stored sync tokens, forcing a full sync on the next run |

---

## Configuration reference

All constants live at the top of `code.gs`.

### Sync window

| Constant | Default | Meaning |
| --- | --- | --- |
| `RELATIVE_MIN_DAY` | `7` | Days into the past a *full* sync reads |
| `RELATIVE_MAX_DAY` | `14` | Days into the future a *full* sync reads |
| `EVENT_WINDOW_PAST_DAYS` | `90` | Hard limit — events starting earlier are never written to Notion |
| `EVENT_WINDOW_FUTURE_DAYS` | `365` | Hard limit — events starting later are never written to Notion |

The `EVENT_WINDOW_*` pair is a safety net, not a second sync window.
Incremental syncs are not bounded by `RELATIVE_*`, so without it a far-future
occurrence of somebody else's endless recurring series can reach the database.
Tighten it towards `RELATIVE_*` if you want a stricter net.

### Behaviour

| Constant | Default | Meaning |
| --- | --- | --- |
| `ARCHIVE_CANCELLED_EVENTS` | `true` | Archive the Notion page when its event is cancelled |
| `DELETE_CANCELLED_EVENTS` | `true` | Delete calendar events for pages tagged `Cancel and Remove` |
| `IGNORE_RECENTLY_PUSHED` | `true` | Don't let a just-pushed change bounce straight back |
| `SKIP_BAD_EVENTS` | `true` | Skip malformed events instead of aborting the run |

### Reliability

| Constant | Default | Meaning |
| --- | --- | --- |
| `MAX_RUNTIME_MS` | `4 min` | Stop gracefully before Apps Script's 6-minute kill |
| `MAX_GCAL_WRITES_PER_RUN` | `60` | Cap on calendar writes per run, across all targets |
| `MAX_RETRIES` | `4` | Retries for rate limits, 5xx and proxy timeouts |
| `NOTION_BATCH_SIZE` | `10` | Parallel Notion writes per batch (the API allows ~3 req/s) |
| `LOCK_WAIT_MS` | `30 s` | How long a run waits for a previous run to finish |

If you run the trigger more often than every 5 minutes, lower `LOCK_WAIT_MS` to
around `5000` so blocked runs exit immediately instead of idling.

---

## Troubleshooting

Check *Executions* in the Apps Script editor first — every skip and failure is
logged with a reason.

| Symptom | Cause and fix |
| --- | --- |
| `Exceeded maximum execution time` | A run has more work than fits in 6 minutes. The time budget and write cap should prevent this; if it persists, look for `Time budget reached` or `per-run write limit` in the log |
| `Notion token is invalid (401)` | `NOTION_TOKEN` is wrong or was revoked |
| `Notion object not found (404)` | The database is not shared with the integration |
| `Notion returned an HTML error page` | A Notion outage. Retried automatically; a single line in the log is normal |
| `Authorization is required to perform that action` | The trigger's OAuth grant expired or the required scopes changed. Run any function by hand and accept the prompt. If it persists, delete and re-create the trigger |
| `Calendar … is configured in both …` | The same calendar id appears in two sync targets. Each calendar belongs to exactly one |
| `Another sync run is still in progress` | Normal under load. If it appears constantly, the trigger interval is shorter than the actual runtime |
| Events not appearing in Notion | Check the log — recurring, all-day and out-of-window events are skipped by design |

---

## What changed compared to the original

The original works, but fails intermittently under real use. The failures traced
back to a handful of specific defects.

### The root cause of the timeouts

`syncToGCal` never stamped `Last Sync` after a successful event update. Because
those event ids are also skipped on the way back by `IGNORE_RECENTLY_PUSHED`,
nothing ever updated the field — so `isPageUpdatedRecently` stayed true forever
and **every page ever edited in Notion was re-pushed on every single run**. The
set grew until each run exceeded the 6-minute limit.

### Correctness

- Stamp `Last Sync` after a successful event update (the fix above)
- One sync token **per calendar** instead of a single shared one — with several
  calendars the tokens overwrote each other on every run
- Store the sync token only after a calendar has been fully processed; the
  original returned early on an empty page and never advanced it
- Fix the full-sync fallback passing a calendar *id* where a *name* was
  expected, which crashed the recovery path itself
- Skip occurrences of recurring series (`recurringEventId`), not just the series
  master — occurrences carry no `recurrence` of their own and slipped through
- Drop events starting outside a sane date window
- Shift all-day end dates by +1 day consistently; update used `+2` and create
  used `+1`, so multi-day events drifted a day on every edit
- Create before delete when an event moves to another calendar, so a failed
  create cannot lose the event
- Split the `contains` / `does_not_contain` filter that Notion silently ignored
  when both were in one filter object
- Honour the `Ignore Sync` tag in the Google Calendar → Notion direction too

### Robustness

- Retry rate limits, 5xx responses and proxy timeouts with exponential backoff
- Send Notion writes in chunks; one failed write no longer aborts the run
- Look up pages for 20 events per query instead of one query per event
- Run under a script lock, with a runtime budget and a per-run write cap
- Condense Notion's HTML outage pages to a single log line
- Truncate over-long text instead of discarding the event
- Guard every optional Notion property against missing or renamed fields
- One broken calendar no longer stops the others; errors are collected and
  reported together at the end

### Features

- **Multiple Notion databases** via `SYNC_TARGETS`
- `showConfiguration()` for checking the setup
- Property renamed from `Date` to `Do Date`, cancel tag from
  `Cancelled/Removed` to `Cancel and Remove`

Setups still using the original `CALENDAR_IDS` plus a `DATABASE_ID` script
property keep working unchanged and are treated as a single sync target.

---

## Origin and license

Based on
[YA-GCal-Notion-Sync-Script](https://github.com/hk21702/YA-GCal-Notion-Sync-Script)
by [hk21702](https://github.com/hk21702), licensed under the
**GNU General Public License v3.0**.

This fork is a derivative work and is therefore released under the same license.
See [LICENSE](LICENSE) for the full text.

Because GPL-3.0 is copyleft, anything you build on top of this must also be
GPL-3.0 if you distribute it.
