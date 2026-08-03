/**
 * Notion <-> Google Calendar two-way sync
 * ---------------------------------------
 * Based on YA-GCal-Notion-Sync-Script by hk21702
 * https://github.com/hk21702/YA-GCal-Notion-Sync-Script
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version. See the LICENSE file for the full text.
 *
 * Reliability-hardened version, revision 3 (2026-08-03).
 * See README.md for the full list of changes against the original.
 *
 * Revision 3: multiple Notion databases. Each database ("sync target") owns a
 * set of calendars. A database may own any number of calendars; a calendar
 * belongs to exactly one database, otherwise a new event would have no
 * deterministic home. That rule is enforced at startup.
 *
 * Revision 2 added: occurrences of recurring series are skipped, and a hard
 * sanity window for event dates.
 *
 * Setup:
 *   - enable the advanced "Calendar" service (Services -> Calendar API)
 *   - script property: NOTION_TOKEN
 *   - SYNC_TARGETS lives in targets.gs - do NOT declare it here as well,
 *     a duplicate `const` breaks the whole Apps Script project
 *   - time-based trigger runs main()
 *
 * Legacy setups that still define CALENDAR_IDS plus a DATABASE_ID script
 * property keep working; they are treated as a single sync target.
 *
 * After installing: run showConfiguration() to check targets.gs, then
 * resetSyncTokens() once, then fullSync() once, by hand.
 */

// ---------------------------------------------------------------------------
// Notion property names (identical across all databases)
// ---------------------------------------------------------------------------
const NAME_NOTION = 'Name';
const DATE_NOTION = 'Do Date';
const TAGS_NOTION = 'Tags';
const LOCATION_NOTION = 'Location';
const DESCRIPTION_NOTION = 'Description';

const EVENT_ID_NOTION = 'Event ID';
const CALENDAR_NAME_NOTION = 'Calendar';
const CALENDAR_ID_NOTION = 'Calendar ID';
const LAST_SYNC_NOTION = 'Last Sync';

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------
const ARCHIVE_CANCELLED_EVENTS = true;
const DELETE_CANCELLED_EVENTS = true;
const IGNORE_RECENTLY_PUSHED = true; // Prevents recently modified events from being overwritten by Google Calendar
const SKIP_BAD_EVENTS = true;

const CANCELLED_TAG_NAME = 'Cancel and Remove';
const IGNORE_SYNC_TAG_NAME = 'Ignore Sync';

// Relative to the time of last full sync in days.
const RELATIVE_MAX_DAY = 14;
const RELATIVE_MIN_DAY = 7;

// Hard sanity window for anything coming FROM Google Calendar.
// Incremental syncs (sync token) are NOT limited by RELATIVE_MIN/MAX_DAY, so a
// stray far-future occurrence of a colleague's endless recurring series could
// otherwise land in Notion. Anything starting outside this window is dropped.
// Tighten these towards RELATIVE_MIN/MAX_DAY if you want a stricter net.
const EVENT_WINDOW_PAST_DAYS = 90;
const EVENT_WINDOW_FUTURE_DAYS = 365;

// ---------------------------------------------------------------------------
// Reliability tuning
// ---------------------------------------------------------------------------
const MAX_RUNTIME_MS = 4 * 60 * 1000; // stop gracefully before the 6 min Apps Script limit
const LOCK_WAIT_MS = 30 * 1000; // wait this long for a concurrent run to finish
const MAX_RETRIES = 4; // retries for transient API failures
const RETRY_BASE_DELAY_MS = 800;
const MAX_GCAL_WRITES_PER_RUN = 60; // safety net across ALL targets combined
const ERROR_BODY_LIMIT = 400; // keep failure mails readable (Notion returns full HTML pages)
const NOTION_BATCH_SIZE = 10; // parallel Notion writes per fetchAll call (rate limit ~3 req/s)
const NOTION_BATCH_PAUSE_MS = 400;
const NOTION_MAX_QUERY_PAGES = 5; // pagination cap per database query (5 * 100 pages)
const NOTION_TEXT_LIMIT = 2000; // Notion rich_text / title limit per element
const EVENT_LOOKUP_CHUNK = 20; // event ids per batched Notion lookup

var NOTION_TOKEN;
var TARGETS = []; // resolved sync targets, see resolveSyncTargets()

let RUN_DEADLINE = 0;
let GCAL_WRITES_THIS_RUN = 0;
const CALENDAR_CACHE = {};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Main entry point. Attach your time-driven trigger to this function. */
function main() {
    const lock = LockService.getScriptLock();

    if (!lock.tryLock(LOCK_WAIT_MS)) {
        console.log('[SYNC] Another sync run is still in progress. Skipping this run.');
        return;
    }

    const errors = [];

    try {
        startRunClock();
        resolveSyncTargets();
        pruneSyncTokens();

        if (DELETE_CANCELLED_EVENTS) {
            for (const target of TARGETS) {
                if (outOfTime()) break;
                try {
                    deleteCancelledEvents(target);
                } catch (e) {
                    errors.push('deleteCancelledEvents(' + target.name + '): ' + errorText(e));
                    console.error('[-GCal] [%s] deleteCancelledEvents failed: %s', target.name, errorText(e));
                }
            }
        }

        // Event ids are globally unique in Google Calendar, so one set across
        // all targets is enough to protect freshly pushed events.
        let recentlyModifiedEventIds = new Set();

        for (const target of TARGETS) {
            if (outOfTime()) break;
            try {
                syncTargetToGCal(target, recentlyModifiedEventIds);
            } catch (e) {
                errors.push('syncToGCal(' + target.name + '): ' + errorText(e));
                console.error('[+GC] [%s] syncToGCal failed: %s', target.name, errorText(e));
            }
        }

        if (!IGNORE_RECENTLY_PUSHED) {
            recentlyModifiedEventIds = new Set();
        } else if (recentlyModifiedEventIds.size > 0) {
            console.log('[SYNC] Ignoring %d recently modified events to prevent overwrites', recentlyModifiedEventIds.size);
        }

        for (const target of TARGETS) {
            for (const c_name of target.calendar_names) {
                if (outOfTime()) {
                    console.log('[SYNC] Time budget reached. Stopping before "%s / %s". It will be picked up next run.', target.name, c_name);
                    break;
                }
                try {
                    syncFromGCal(target, c_name, false, recentlyModifiedEventIds);
                } catch (e) {
                    // One broken calendar must not stop the others.
                    errors.push('syncFromGCal(' + target.name + '/' + c_name + '): ' + errorText(e));
                    console.error('[+ND] [%s] Sync from calendar "%s" failed: %s', target.name, c_name, errorText(e));
                }
            }
        }
    } finally {
        lock.releaseLock();
    }

    // Still surface problems (trigger failure mail), but only after everything
    // that *could* run has run.
    if (errors.length > 0) {
        throw new Error('Sync finished with ' + errors.length + ' error(s):\n- ' + errors.join('\n- '));
    }
}

/**
 * Syncs every calendar of every target from Google Calendar to Notion using a
 * full sync. Discards all sync tokens and resets the time window around "now".
 */
function fullSync() {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_MS)) {
        console.log('[SYNC] Another sync run is still in progress. Skipping full sync.');
        return;
    }

    try {
        startRunClock();
        resolveSyncTargets();
        pruneSyncTokens();

        console.log('Performing full sync. Sync tokens, time min and time max will be reset.');

        for (const target of TARGETS) {
            for (const c_name of target.calendar_names) {
                if (outOfTime()) {
                    console.log('[SYNC] Time budget reached. Stopping before "%s / %s".', target.name, c_name);
                    return;
                }
                try {
                    syncFromGCal(target, c_name, true, new Set());
                } catch (e) {
                    console.error('[+ND] [%s] Full sync for calendar "%s" failed: %s', target.name, c_name, errorText(e));
                }
            }
        }
    } finally {
        lock.releaseLock();
    }
}

/** Utility: forget every stored sync token (next run does a full sync). */
function resetSyncTokens() {
    const properties = PropertiesService.getUserProperties();
    const all = properties.getProperties();
    let removed = 0;

    for (const key of Object.keys(all)) {
        if (key.indexOf('syncToken') !== 0) continue;
        properties.deleteProperty(key);
        removed++;
    }

    console.log('Cleared %d sync token(s).', removed);
}

/** Utility: print the resolved configuration. Run by hand to check targets.gs. */
function showConfiguration() {
    resolveSyncTargets();

    let calendars = 0;
    for (const target of TARGETS) {
        console.log('Target "%s" -> database %s', target.name, target.database_id);
        for (const c_name of target.calendar_names) {
            console.log('    %s -> %s', c_name, target.calendars[c_name]);
            calendars++;
        }
    }
    console.log('%d target(s), %d calendar(s) in total.', TARGETS.length, calendars);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Reads NOTION_TOKEN and normalises the sync targets into TARGETS.
 * Throws with an actionable message on any configuration problem.
 */
function resolveSyncTargets() {
    const properties = PropertiesService.getScriptProperties();

    NOTION_TOKEN = properties.getProperty('NOTION_TOKEN');
    if (!NOTION_TOKEN) throw new Error('Script property "NOTION_TOKEN" is not set.');

    let raw_targets;

    if (typeof SYNC_TARGETS !== 'undefined' && SYNC_TARGETS && SYNC_TARGETS.length > 0) {
        raw_targets = SYNC_TARGETS;
    } else if (typeof CALENDAR_IDS !== 'undefined' && CALENDAR_IDS) {
        // Legacy single-database setup from before revision 3.
        const legacy_database = properties.getProperty('DATABASE_ID');
        if (!legacy_database) {
            throw new Error('No SYNC_TARGETS configured and script property "DATABASE_ID" is not set. See targets.example.gs.');
        }
        console.log('[CFG] Using legacy single-database configuration (CALENDAR_IDS + DATABASE_ID).');
        raw_targets = [{ name: 'Default', database_id: legacy_database, calendars: CALENDAR_IDS }];
    } else {
        throw new Error('No calendar configuration found. Define SYNC_TARGETS in targets.gs - see targets.example.gs.');
    }

    const resolved = [];
    const calendar_owner = {}; // calendar id -> target name
    const used_names = {};

    for (let i = 0; i < raw_targets.length; i++) {
        const raw = raw_targets[i] || {};
        const name = raw.name || 'Target ' + (i + 1);

        if (used_names[name]) {
            throw new Error('Two sync targets are both named "' + name + '". Target names must be unique.');
        }
        used_names[name] = true;

        const database_id = extractDatabaseId(raw.database_id);
        if (!database_id) {
            throw new Error('Sync target "' + name + '" has no usable database_id ("' + raw.database_id + '"). Use the database URL or the 32 character id.');
        }

        const calendars = raw.calendars || {};
        const calendar_names = Object.keys(calendars);

        if (calendar_names.length === 0) {
            console.log('[CFG] Sync target "%s" has no calendars configured. Skipping it.', name);
            continue;
        }

        for (const c_name of calendar_names) {
            const calendar_id = calendars[c_name];

            if (!calendar_id) {
                throw new Error('Calendar "' + c_name + '" in sync target "' + name + '" has an empty calendar id.');
            }

            // A calendar may only belong to one database - otherwise a new
            // event has no deterministic home. Several calendars per database
            // are of course fine.
            if (calendar_owner[calendar_id]) {
                throw new Error('Calendar ' + calendar_id + ' is configured in both "' + calendar_owner[calendar_id] + '" and "' + name + '". Each calendar must belong to exactly one sync target.');
            }
            calendar_owner[calendar_id] = name;
        }

        resolved.push({
            name: name,
            database_id: database_id,
            calendars: calendars,
            calendar_names: calendar_names,
        });
    }

    if (resolved.length === 0) {
        throw new Error('No usable sync target found. Check targets.gs.');
    }

    TARGETS = resolved;
    return resolved;
}

/** Accepts a full Notion URL or a raw id, with or without dashes. */
function extractDatabaseId(raw) {
    if (!raw) return null;
    const trimmed = String(raw).trim().split('?')[0].split('#')[0];

    const dashed = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (dashed) return dashed[0];

    const plain = trimmed.match(/[0-9a-f]{32}/gi);
    return plain ? plain[plain.length - 1] : null;
}

/**
 * Sync tokens are keyed by calendar id, which survives renaming a calendar key
 * or a target.
 */
function syncTokenKey(calendar_id) {
    return 'syncToken::' + calendar_id;
}

/**
 * Drop tokens for calendars that are no longer configured, so user properties
 * cannot grow without bound. Also clears the legacy shared 'syncToken' and the
 * revision 2 'syncToken::<calendar name>' keys.
 */
function pruneSyncTokens() {
    const properties = PropertiesService.getUserProperties();
    const all = properties.getProperties();

    const valid = {};
    for (const target of TARGETS) {
        for (const c_name of target.calendar_names) {
            valid[syncTokenKey(target.calendars[c_name])] = true;
        }
    }

    for (const key of Object.keys(all)) {
        if (key.indexOf('syncToken') !== 0) continue;
        if (valid[key]) continue;

        properties.deleteProperty(key);
        console.log('[CFG] Removed obsolete sync token "%s".', key);
    }
}

// ---------------------------------------------------------------------------
// Run clock / retry helpers
// ---------------------------------------------------------------------------

function startRunClock() {
    RUN_DEADLINE = Date.now() + MAX_RUNTIME_MS;
    GCAL_WRITES_THIS_RUN = 0;
}

function outOfTime() {
    return RUN_DEADLINE > 0 && Date.now() > RUN_DEADLINE;
}

function errorText(e) {
    if (!e) return 'unknown error';
    return String(e.stack || e.message || e);
}

/** True for failures that are worth retrying (rate limits, 5xx, flaky services). */
function isRetryableError(e) {
    if (e && typeof e.retryable === 'boolean') return e.retryable;
    const msg = String((e && e.message) || e || '');
    return /rate.?limit|too many|quota|timed? ?out|timeout|internal error|Error code INTERNAL|unexpected error|server error occurred|backend error|service unavailable|currently unavailable|temporarily|try again|Address unavailable|Bad Gateway|502|503|504|52\d/i.test(msg);
}

/** Runs fn, retrying transient failures with exponential backoff + jitter. */
function withRetry(label, fn) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return fn();
        } catch (e) {
            lastError = e;
            if (!isRetryableError(e) || attempt === MAX_RETRIES || outOfTime()) throw e;
            const wait = RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
            console.log('[retry] %s failed (%s). Attempt %d/%d, waiting %dms.', label, (e && e.message) || e, attempt + 1, MAX_RETRIES, wait);
            Utilities.sleep(wait);
        }
    }
    throw lastError;
}

// ---------------------------------------------------------------------------
// Notion -> Google Calendar
// ---------------------------------------------------------------------------

/**
 * Push recently edited pages of one target to Google Calendar.
 * @param {Object} target Resolved sync target
 * @param {Set<String>} modified_eIds Collects event ids touched by this run
 */
function syncTargetToGCal(target, modified_eIds) {
    console.log('[+GC] [%s] Syncing to Google Calendar.', target.name);

    // Sorted by last edit, so everything that could need a push is at the top.
    // Two pages (200 entries) is plenty and keeps the run cheap.
    const results = queryNotionDatabase(
        target,
        {
            sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
            filter: {
                property: TAGS_NOTION,
                multi_select: { does_not_contain: IGNORE_SYNC_TAG_NAME },
            },
        },
        2,
        true
    );

    for (const result of results) {
        if (outOfTime()) {
            console.log('[+GC] [%s] Time budget reached. Remaining pages will be handled next run.', target.name);
            break;
        }
        if (GCAL_WRITES_THIS_RUN >= MAX_GCAL_WRITES_PER_RUN) {
            console.log('[+GC] [%s] Reached the per-run write limit (%d). Remaining pages will be handled next run.', target.name, MAX_GCAL_WRITES_PER_RUN);
            break;
        }

        if (!isPageUpdatedRecently(result)) continue;
        GCAL_WRITES_THIS_RUN++;

        const event = convertToGCalEvent(result);
        if (!event) {
            console.log('[+GC] [%s] Skipping page %s: not in the correct format or missing required information.', target.name, result.id);
            continue;
        }

        const calendar_id = getSelectName(result, CALENDAR_ID_NOTION);
        const calendar_name = getSelectName(result, CALENDAR_NAME_NOTION);
        const target_calendar_id = calendar_name ? target.calendars[calendar_name] : null;

        if (!target_calendar_id) {
            console.log('[+GC] [%s] Calendar "%s" is not configured for this target. Skipping page %s.', target.name, calendar_name, result.id);
            continue;
        }

        // Existing event
        if (calendar_id && event.id) {
            if (calendar_id === target_calendar_id) {
                const status = pushEventUpdate(event, event.id, calendar_id);

                if (status === 'OK') {
                    console.log('[+GC] [%s] Updated event %s in %s.', target.name, event.id, calendar_name);
                    // IMPORTANT: stamp Last Sync, otherwise this page looks
                    // "recently edited" forever and gets re-pushed every run.
                    pushDatabaseUpdate(getBaseNotionProperties(target, event.id, calendar_name), result.id);
                    modified_eIds.add(event.id);
                } else if (status === 'NOT_FOUND') {
                    console.log('[+GC] [%s] Event %s no longer exists in %s. Recreating.', target.name, event.id, calendar_name);
                    const recreated_id = createEvent(target, result, event, calendar_name);
                    if (recreated_id) modified_eIds.add(recreated_id);
                } else {
                    console.log('[+GC] [%s] Failed to update event %s in %s.', target.name, event.id, calendar_name);
                }
                continue;
            }

            // Moving to a different calendar: create first, delete afterwards,
            // so a failed create can never lose the event.
            const moved_id = createEvent(target, result, event, calendar_name);
            if (moved_id) {
                deleteEvent(event.id, calendar_id);
                console.log('[+GC] [%s] Event %s moved to %s (new id %s).', target.name, event.id, calendar_name, moved_id);
                modified_eIds.add(moved_id);
            } else {
                console.log('[+GC] [%s] Event %s failed to move to %s. Original kept.', target.name, event.id, calendar_name);
            }
            continue;
        }

        // New event
        const created_id = createEvent(target, result, event, calendar_name);
        if (created_id) {
            console.log('[+GC] [%s] Event created in %s.', target.name, calendar_name);
            modified_eIds.add(created_id);
        }
    }
}

/** Delete events marked as cancelled in one Notion database from Google Calendar */
function deleteCancelledEvents(target) {
    console.log('[-GCal] [%s] Deleting cancel-tagged events from GCal', target.name);

    // Note: two conditions on the same multi_select property must be separate
    // filter objects - Notion only honours one operator per filter object.
    const results = queryNotionDatabase(target, {
        filter: {
            and: [
                { property: TAGS_NOTION, multi_select: { contains: CANCELLED_TAG_NAME } },
                { property: TAGS_NOTION, multi_select: { does_not_contain: IGNORE_SYNC_TAG_NAME } },
            ],
        },
    });

    for (const result of results) {
        if (outOfTime()) {
            console.log('[-GCal] [%s] Time budget reached. Remaining cancellations will be handled next run.', target.name);
            break;
        }
        if (!isPageUpdatedRecently(result)) continue;

        const event_id_prop = result.properties ? result.properties[EVENT_ID_NOTION] : null;
        const event_id = event_id_prop ? flattenRichText(event_id_prop.rich_text) : '';
        const calendar_id = getSelectName(result, CALENDAR_ID_NOTION);

        if (event_id && calendar_id) {
            deleteEvent(event_id, calendar_id);
        } else {
            console.log('[-GCal] [%s] Page %s is missing Event ID or Calendar ID. Archiving only.', target.name, result.id);
        }

        if (ARCHIVE_CANCELLED_EVENTS) {
            pushDatabaseUpdate({}, result.id, true);
        }
    }
}

// ---------------------------------------------------------------------------
// Google Calendar -> Notion
// ---------------------------------------------------------------------------

/**
 * Syncs one calendar of one target from Google Calendar to Notion.
 * @param {Object} target Resolved sync target
 * @param {String} c_name Calendar name (key inside target.calendars)
 * @param {Boolean} forceFullSync Whether to discard the stored sync token
 * @param {Set<String>} ignored_eIds Event IDs to not act on
 */
function syncFromGCal(target, c_name, forceFullSync, ignored_eIds) {
    const calendar_id = target.calendars[c_name];
    if (!calendar_id) {
        console.log('[+ND] [%s] Unknown calendar name "%s". Skipping.', target.name, c_name);
        return;
    }

    console.log('[+ND] [%s] Syncing from Google Calendar: %s', target.name, c_name);

    const properties = PropertiesService.getUserProperties();
    const tokenKey = syncTokenKey(calendar_id);
    let useFullSync = forceFullSync || !properties.getProperty(tokenKey);

    // At most one automatic fallback from incremental to full sync.
    for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = runCalendarSync(target, c_name, calendar_id, useFullSync, ignored_eIds, properties, tokenKey);
        if (outcome !== 'RETRY_FULL') return;

        console.log('[+ND] [%s] Sync token for "%s" is no longer valid. Falling back to a full sync.', target.name, c_name);
        properties.deleteProperty(tokenKey);
        useFullSync = true;
    }
}

/**
 * One pass over a single calendar.
 * @returns {'OK'|'STOPPED'|'RETRY_FULL'}
 */
function runCalendarSync(target, c_name, calendar_id, useFullSync, ignored_eIds, properties, tokenKey) {
    const options = {
        maxResults: 100,
        singleEvents: false, // don't expand recurring events - we filter them out
    };

    if (useFullSync) {
        options.timeMin = getRelativeDate(-RELATIVE_MIN_DAY, 0).toISOString();
        options.timeMax = getRelativeDate(RELATIVE_MAX_DAY, 0).toISOString();
    } else {
        options.syncToken = properties.getProperty(tokenKey);
        options.showDeleted = true; // needed to see cancellations
    }

    let pageToken = null;
    let nextSyncToken = null;

    do {
        if (outOfTime()) {
            console.log('[+ND] [%s] Time budget reached while syncing "%s". Sync token not advanced, will resume next run.', target.name, c_name);
            return 'STOPPED';
        }

        options.pageToken = pageToken || undefined;

        let events;
        try {
            events = withRetry('Calendar.Events.list(' + c_name + ')', function () {
                return Calendar.Events.list(calendar_id, options);
            });
        } catch (e) {
            if (isInvalidSyncTokenError(e)) return 'RETRY_FULL';
            throw e;
        }

        const items = events.items || [];
        if (items.length > 0) {
            console.log('[+ND] [%s] Parsing %d changed event(s). %s', target.name, items.length, c_name);
            parseEvents(target, items, c_name, ignored_eIds);
        } else {
            console.log('[+ND] [%s] No changes. %s', target.name, c_name);
        }

        pageToken = events.nextPageToken;
        nextSyncToken = events.nextSyncToken || nextSyncToken;
    } while (pageToken);

    // Only store the token once the whole calendar was processed successfully.
    if (nextSyncToken) {
        properties.setProperty(tokenKey, nextSyncToken);
    }
    return 'OK';
}

function isInvalidSyncTokenError(e) {
    const msg = String((e && e.message) || e || '');
    const code = e && e.details && e.details.code;
    return code === 410 || /sync token is no longer valid|fullSyncRequired|Gone/i.test(msg);
}

/**
 * Determine if GCal events need to be updated, removed or added to the database
 * @param {Object} target Resolved sync target that owns this calendar
 * @param {Object[]} items Google Calendar event resources
 * @param {String} c_name Calendar name
 * @param {Set<String>} ignored_eIds Event IDs to not act on
 */
function parseEvents(target, items, c_name, ignored_eIds) {
    const candidates = [];

    for (const event of items) {
        event.c_name = c_name;

        if (ignored_eIds.has(event.id)) {
            console.log('[+ND] Ignoring recently modified event %s (to prevent overwrite)', event.id);
            continue;
        }

        if (event.status === 'cancelled') {
            console.log('[+ND] Event %s was cancelled.', event.id);
            handleEventCancelled(target, event);
            continue;
        }

        // Master of a recurring series (carries the RRULE).
        if (event.recurrence) {
            console.log('[+ND] Skipping recurring series %s "%s".', event.id, event.summary);
            continue;
        }

        // Single occurrence / exception of a recurring series. The original
        // script did not catch these - they have no `recurrence` of their own.
        if (event.recurringEventId) {
            console.log('[+ND] Skipping occurrence %s of recurring series %s "%s".', event.id, event.recurringEventId, event.summary);
            continue;
        }

        if (!event.start || !event.end) {
            console.log('[+ND] Skipping event %s: no start/end information.', event.id);
            continue;
        }

        if (event.start.date) {
            console.log('[+ND] Skipping all-day event %s (%s).', event.id, event.summary);
            continue;
        }

        if (!isEventWithinSaneWindow(event)) {
            console.log('[+ND] Skipping event %s "%s" (%s): starts outside the plausible sync window (-%dd/+%dd).', event.id, event.summary, event.start.dateTime, EVENT_WINDOW_PAST_DAYS, EVENT_WINDOW_FUTURE_DAYS);
            continue;
        }

        console.log('[+ND] Event found %s %s (%s)', event.id, event.summary, event.start.dateTime);
        candidates.push(event);
    }

    if (candidates.length === 0) return;

    // One batched lookup instead of one query per event.
    const existing_pages = getPagesForEvents(target, candidates.map(function (e) { return e.id; }));

    const requests = [];
    for (const event of candidates) {
        const page = existing_pages[event.id];

        if (page) {
            const tags_prop = page.properties ? page.properties[TAGS_NOTION] : null;
            const tags = tags_prop && tags_prop.multi_select ? tags_prop.multi_select : [];

            if (hasTag(tags, IGNORE_SYNC_TAG_NAME)) {
                console.log('[+ND] Page %s is tagged "%s". Not overwriting from GCal.', page.id, IGNORE_SYNC_TAG_NAME);
                continue;
            }

            console.log('[+ND] Event %s -> existing page %s. Updating.', event.id, page.id);
            requests.push(updateDatabaseEntry(target, event, page.id, tags));
            continue;
        }

        try {
            requests.push(createDatabaseEntry(target, event));
        } catch (err) {
            if (err instanceof InvalidEventError && SKIP_BAD_EVENTS) {
                console.log('[+ND] Skipping creation of event %s due to invalid properties.', event.id);
                continue;
            }
            throw err;
        }
    }

    sendNotionBatch(requests);
}

/**
 * Sends Notion writes in small chunks with retries.
 * A single failing write no longer aborts the whole run.
 */
function sendNotionBatch(requests) {
    if (!requests || requests.length === 0) return;

    console.log('[+ND] Sending %d Notion write(s).', requests.length);
    let failed = 0;

    for (let i = 0; i < requests.length; i += NOTION_BATCH_SIZE) {
        const chunk = requests.slice(i, i + NOTION_BATCH_SIZE);

        let responses;
        try {
            responses = UrlFetchApp.fetchAll(chunk);
        } catch (e) {
            console.error('[+ND] Batch request failed entirely: %s', errorText(e));
            failed += retryNotionWrites(chunk);
            continue;
        }

        const retryable = [];
        for (let j = 0; j < responses.length; j++) {
            const code = responses[j].getResponseCode();
            if (code === 200) continue;

            if (code === 401) throw new Error('[+ND] Notion token is invalid (401).');

            if (code === 429 || code === 409 || code >= 500) {
                retryable.push(chunk[j]);
                continue;
            }

            failed++;
            console.error('[+ND] Notion write failed (%d): %s', code, summarizeErrorBody(responses[j].getContentText()));
        }

        if (retryable.length > 0) {
            Utilities.sleep(1500);
            failed += retryNotionWrites(retryable);
        }

        if (i + NOTION_BATCH_SIZE < requests.length) Utilities.sleep(NOTION_BATCH_PAUSE_MS);
    }

    if (failed > 0) {
        console.error('[+ND] %d Notion write(s) failed permanently. They will be retried on a later run.', failed);
    }
}

function retryNotionWrites(requests) {
    let failed = 0;
    for (const req of requests) {
        try {
            withRetry('notion write', function () {
                const response = UrlFetchApp.fetch(req.url, req);
                const code = response.getResponseCode();
                if (code !== 200) throw notionError(code, response);
                return response;
            });
        } catch (e) {
            failed++;
            console.error('[+ND] Notion write failed permanently: %s', (e && e.message) || e);
        }
    }
    return failed;
}

// ---------------------------------------------------------------------------
// Notion database access
// ---------------------------------------------------------------------------

/**
 * Query one target's database with pagination.
 * @param {Object} target Resolved sync target
 * @param {Object} payload query body (filter / sorts)
 * @param {Number} maxPages safety cap
 * @param {Boolean} quiet suppress the "hit the page cap" log
 * @returns {Object[]} page results
 */
function queryNotionDatabase(target, payload, maxPages, quiet) {
    const url = getDatabaseURL(target.database_id);
    const limit = maxPages || NOTION_MAX_QUERY_PAGES;

    let results = [];
    let cursor = null;
    let pages = 0;

    do {
        const body = Object.assign({ page_size: 100 }, payload);
        if (cursor) body.start_cursor = cursor;

        const data = notionFetch(url, body, 'POST');
        results = results.concat(data.results || []);

        cursor = data.has_more ? data.next_cursor : null;
        pages++;
    } while (cursor && pages < limit && !outOfTime());

    if (cursor && !quiet) {
        console.log('[Notion] [%s] Query hit the %d page cap - some results were not processed this run.', target.name, limit);
    }
    return results;
}

/**
 * Look up Notion pages for many event ids at once, within one target.
 * @returns {Object} map of event id -> page
 */
function getPagesForEvents(target, event_ids) {
    const map = {};
    const unique = Array.from(new Set(event_ids.filter(Boolean)));

    for (let i = 0; i < unique.length; i += EVENT_LOOKUP_CHUNK) {
        if (outOfTime()) break;

        const chunk = unique.slice(i, i + EVENT_LOOKUP_CHUNK);
        const results = queryNotionDatabase(target, {
            filter: {
                or: chunk.map(function (id) {
                    return { property: EVENT_ID_NOTION, rich_text: { equals: id } };
                }),
            },
        });

        for (const page of results) {
            const prop = page.properties ? page.properties[EVENT_ID_NOTION] : null;
            const id = prop ? flattenRichText(prop.rich_text) : '';
            if (!id) continue;
            if (map[id]) {
                console.log('[Notion] [%s] Multiple pages carry event id %s. Using the first one.', target.name, id);
                continue;
            }
            map[id] = page;
        }
    }

    return map;
}

/**
 * Get the Notion page ID of the corresponding GCal event within one target.
 * @returns {String|null}
 */
function getPageId(target, event) {
    const results = queryNotionDatabase(
        target,
        {
            filter: {
                and: [
                    { property: EVENT_ID_NOTION, rich_text: { equals: event.id } },
                    { property: TAGS_NOTION, multi_select: { does_not_contain: IGNORE_SYNC_TAG_NAME } },
                ],
            },
        },
        1
    );

    if (results.length === 0) return null;
    if (results.length > 1) {
        console.log('Found multiple entries with event id %s. Only processing the first one.', event.id);
    }
    return results[0].id;
}

/**
 * Interact with the Notion API. Retries transient failures.
 */
function notionFetch(url, payload_dict, method) {
    const options = {
        method: method || 'POST',
        headers: getNotionHeaders(),
        muteHttpExceptions: true,
    };
    if (payload_dict) options.payload = JSON.stringify(payload_dict);

    return withRetry('notion ' + (method || 'POST'), function () {
        const response = UrlFetchApp.fetch(url, options);
        const code = response.getResponseCode();

        if (code === 200) {
            const text = response.getContentText();
            try {
                return JSON.parse(text);
            } catch (e) {
                // A 200 with an unparsable body means a proxy answered, not Notion.
                const parseError = new Error('Could not parse Notion response: ' + summarizeErrorBody(text));
                parseError.retryable = true;
                throw parseError;
            }
        }

        throw notionError(code, response);
    });
}

function notionError(code, response) {
    const body = summarizeErrorBody(response.getContentText());
    let message;

    if (code === 401) message = 'Notion token is invalid (401). ' + body;
    else if (code === 403) message = 'Notion object is not shared with the integration (403). ' + body;
    else if (code === 404) message = 'Notion object not found (404) - is the database shared with the integration? ' + body;
    else message = 'Notion API error ' + code + ': ' + body;

    const e = new Error(message);
    e.statusCode = code;
    e.retryable = code === 429 || code === 409 || code >= 500;
    return e;
}

/**
 * Notion / Cloudflare answer outages with a full HTML page. Dumping that into
 * the log and the failure mail makes them unreadable, so condense it.
 */
function summarizeErrorBody(body) {
    const text = String(body || '');

    if (/<html|<!DOCTYPE/i.test(text)) {
        const ray = text.match(/Ray ID:\s*([0-9a-f]+)/i);
        const cf = text.match(/cf-error-(\d+)/i);
        const headline = text.match(/<h1[^>]*>([^<]+)<\/h1>/i);
        const parts = ['Notion returned an HTML error page (service outage / proxy timeout)'];
        if (headline) parts.push(headline[1].trim());
        if (cf) parts.push('Cloudflare error ' + cf[1]);
        if (ray) parts.push('Ray ID ' + ray[1]);
        return parts.join(' - ');
    }

    return truncate(text, ERROR_BODY_LIMIT);
}

function getNotionHeaders() {
    return {
        Authorization: 'Bearer ' + NOTION_TOKEN,
        Accept: 'application/json',
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
    };
}

function getDatabaseURL(database_id) {
    return 'https://api.notion.com/v1/databases/' + database_id + '/query';
}

/**
 * Update database entry with new event information
 * @returns {*} request object if multi is true, fetch response otherwise
 */
function updateDatabaseEntry(target, event, page_id, existing_tags, multi) {
    if (existing_tags === undefined) existing_tags = [];
    if (multi === undefined) multi = true;

    const properties = convertToNotionProperty(target, event, existing_tags);
    const archive = ARCHIVE_CANCELLED_EVENTS && event.status === 'cancelled';

    return pushDatabaseUpdate(properties, page_id, archive, multi);
}

/**
 * Push an update to a Notion page. Page ids are globally unique, so this needs
 * no target context.
 * @returns {*} request object if multi, otherwise the URL fetch response (or null on failure)
 */
function pushDatabaseUpdate(properties, page_id, archive, multi) {
    const url = 'https://api.notion.com/v1/pages/' + page_id;
    const payload = {
        properties: properties || {},
        archived: !!archive,
    };

    if (archive) console.log('Archiving cancelled event (page %s).', page_id);

    const options = {
        method: 'PATCH',
        headers: getNotionHeaders(),
        muteHttpExceptions: true,
        payload: JSON.stringify(payload),
    };

    if (multi) {
        options.url = url;
        return options;
    }

    try {
        return withRetry('notion patch page', function () {
            const response = UrlFetchApp.fetch(url, options);
            const code = response.getResponseCode();
            if (code !== 200) throw notionError(code, response);
            return response;
        });
    } catch (e) {
        console.error('[Notion] Failed to update page %s: %s', page_id, (e && e.message) || e);
        return null;
    }
}

/**
 * Create a new database entry for the event in the given target
 * @returns {Object} fetchAll request object
 */
function createDatabaseEntry(target, event) {
    const payload = {
        parent: { type: 'database_id', database_id: target.database_id },
        properties: convertToNotionProperty(target, event),
    };

    if (!checkNotionProperty(payload.properties)) {
        throw new InvalidEventError('Invalid Notion property structure');
    }

    return {
        url: 'https://api.notion.com/v1/pages',
        method: 'POST',
        headers: getNotionHeaders(),
        muteHttpExceptions: true,
        payload: JSON.stringify(payload),
    };
}

/**
 * Sanity check on the generated properties (content is already truncated).
 * @returns {Boolean}
 */
function checkNotionProperty(properties) {
    try {
        const rich_text_fields = [DESCRIPTION_NOTION, LOCATION_NOTION];
        for (const field of rich_text_fields) {
            const prop = properties[field];
            if (!prop || !prop.rich_text || !prop.rich_text[0]) continue;
            if (prop.rich_text[0].text.content.length > NOTION_TEXT_LIMIT) {
                console.log('Property "%s" is too long.', field);
                return false;
            }
        }

        const title = properties[NAME_NOTION];
        if (title && title.title && title.title[0] && title.title[0].text.content.length > NOTION_TEXT_LIMIT) {
            console.log('Event title is too long.');
            return false;
        }

        return true;
    } catch (e) {
        console.log('Could not validate Notion properties: %s', (e && e.message) || e);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function truncate(text, limit) {
    const max = limit || NOTION_TEXT_LIMIT;
    const s = text === null || text === undefined ? '' : String(text);
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function getSelectName(page_result, property_name) {
    const prop = page_result && page_result.properties ? page_result.properties[property_name] : null;
    return prop && prop.select ? prop.select.name : null;
}

/**
 * Guard against absurd dates reaching Notion, no matter which code path or API
 * quirk produced them. Purely defensive - legitimate events never trip this.
 * @param {Object} event Google Calendar event resource
 * @returns {Boolean}
 */
function isEventWithinSaneWindow(event) {
    const start_raw = event.start ? event.start.dateTime || event.start.date : null;
    if (!start_raw) return false;

    const start = new Date(start_raw);
    if (isNaN(start.getTime())) return false;

    const now = Date.now();
    const day_ms = 24 * 60 * 60 * 1000;

    return start.getTime() >= now - EVENT_WINDOW_PAST_DAYS * day_ms && start.getTime() <= now + EVENT_WINDOW_FUTURE_DAYS * day_ms;
}

function hasTag(tags, tag_name) {
    if (!Array.isArray(tags)) return false;
    return tags.some(function (t) {
        return t && t.name === tag_name;
    });
}

/**
 * Return a Notion JSON property object based on event data
 */
function convertToNotionProperty(target, event, existing_tags) {
    const properties = getBaseNotionProperties(target, event.id, event.c_name);

    properties[DESCRIPTION_NOTION] = {
        type: 'rich_text',
        rich_text: [{ text: { content: truncate(event.description || '') } }],
    };

    properties[LOCATION_NOTION] = {
        type: 'rich_text',
        rich_text: [{ text: { content: truncate(event.location || '') } }],
    };

    if (event.start) {
        let start_time;
        let end_time;

        if (event.start.date) {
            // All-day event. Notion end dates are inclusive, GCal end dates exclusive.
            start_time = event.start.date;
            end_time = event.end && event.end.date ? shiftDateString(event.end.date, -1) : null;
            if (end_time === start_time) end_time = null;
        } else {
            start_time = event.start.dateTime;
            end_time = event.end ? event.end.dateTime : null;
        }

        if (start_time) {
            properties[DATE_NOTION] = {
                type: 'date',
                date: { start: start_time, end: end_time },
            };
        }

        properties[NAME_NOTION] = {
            type: 'title',
            title: [{ type: 'text', text: { content: truncate(event.summary || '') } }],
        };
    }

    if (event.status === 'cancelled') {
        const tags = Array.isArray(existing_tags) ? existing_tags.slice() : [];
        if (!hasTag(tags, CANCELLED_TAG_NAME)) tags.push({ name: CANCELLED_TAG_NAME });
        properties[TAGS_NOTION] = { multi_select: tags };
    }

    return properties;
}

/** Shift a YYYY-MM-DD string by n days, timezone safe. */
function shiftDateString(date_string, days) {
    const parts = String(date_string).split('-');
    const d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
}

/**
 * Return base Notion property object including generation time
 */
function getBaseNotionProperties(target, event_id, calendar_name) {
    const properties = {
        [LAST_SYNC_NOTION]: {
            type: 'date',
            date: { start: new Date().toISOString() },
        },
        [EVENT_ID_NOTION]: {
            type: 'rich_text',
            rich_text: [{ text: { content: truncate(event_id || '') } }],
        },
    };

    const calendar_id = calendar_name ? target.calendars[calendar_name] : null;
    // Never write undefined into a select - Notion rejects the whole request.
    if (calendar_id) properties[CALENDAR_ID_NOTION] = { select: { name: calendar_id } };
    if (calendar_name) properties[CALENDAR_NAME_NOTION] = { select: { name: calendar_name } };

    return properties;
}

/**
 * Return a GCal event object based on page properties.
 * @returns {Object|false} false if required properties are missing
 */
function convertToGCalEvent(page_result) {
    const props = page_result.properties || {};

    const missing = [NAME_NOTION, DATE_NOTION, EVENT_ID_NOTION].filter(function (p) {
        return !props[p];
    });
    if (missing.length > 0) {
        console.log('[+GC] Page %s is missing propert(ies): %s', page_result.id, missing.join(', '));
        return false;
    }

    const dates = props[DATE_NOTION];
    if (!dates.date || !dates.date.start) return false;

    const e_id = flattenRichText(props[EVENT_ID_NOTION].rich_text);
    const e_summary = flattenRichText(props[NAME_NOTION].title);
    const e_description = props[DESCRIPTION_NOTION] ? flattenRichText(props[DESCRIPTION_NOTION].rich_text) : '';
    const e_location = props[LOCATION_NOTION] ? flattenRichText(props[LOCATION_NOTION].rich_text) : '';

    let start = dates.date.start;
    let end = dates.date.end;
    let all_day = false;

    const hasTime = function (s) {
        return typeof s === 'string' && s.indexOf('T') !== -1;
    };

    if (!hasTime(start)) {
        all_day = true;
        if (end && !hasTime(end)) {
            // keep both as plain dates
        } else {
            end = null;
        }
    } else if (!end) {
        const default_end = new Date(start);
        if (isNaN(default_end.getTime())) return false;
        default_end.setMinutes(default_end.getMinutes() + 30);
        end = default_end.toISOString();
    }

    const start_date = new Date(all_day ? start + 'T00:00:00' : start);
    if (isNaN(start_date.getTime())) {
        console.log('[+GC] Page %s has an unparsable start date "%s".', page_result.id, start);
        return false;
    }

    let end_date = null;
    if (end) {
        end_date = new Date(all_day ? end + 'T00:00:00' : end);
        if (isNaN(end_date.getTime())) end_date = null;
    }

    return {
        ...(e_id && { id: e_id }),
        summary: e_summary,
        description: e_description,
        location: e_location,
        start: start_date,
        end: end_date,
        all_day: all_day,
    };
}

/**
 * Flattens rich text properties into a single string.
 */
function flattenRichText(rich_text_result) {
    if (!Array.isArray(rich_text_result)) return '';

    let plain_text = '';
    for (const item of rich_text_result) {
        if (!item) continue;
        if (item.rich_text && item.rich_text.plain_text) plain_text += item.rich_text.plain_text;
        else if (item.plain_text) plain_text += item.plain_text;
    }
    return plain_text;
}

function getRelativeDate(daysOffset, hour) {
    const date = new Date();
    date.setDate(date.getDate() + daysOffset);
    date.setHours(hour);
    date.setMinutes(0);
    date.setSeconds(0);
    date.setMilliseconds(0);
    return date;
}

/** Determine if a page has been edited since the last sync. */
function isPageUpdatedRecently(page_result) {
    const prop = page_result.properties ? page_result.properties[LAST_SYNC_NOTION] : null;
    const last_sync_date = prop && prop.date ? prop.date.start : 0;
    return new Date(last_sync_date) < new Date(page_result.last_edited_time);
}

/** Deals with an event cancelled on the GCal side */
function handleEventCancelled(target, event) {
    const page_id = getPageId(target, event);

    if (page_id) {
        updateDatabaseEntry(target, event, page_id, [], false);
    } else {
        console.log('Event %s not found in database "%s". Skipping.', event.id, target.name);
    }
}

// ---------------------------------------------------------------------------
// Google Calendar access
// ---------------------------------------------------------------------------

/** Cached calendar lookup - CalendarApp.getCalendarById is expensive. */
function getCalendar(calendar_id) {
    if (!calendar_id) return null;
    if (Object.prototype.hasOwnProperty.call(CALENDAR_CACHE, calendar_id)) return CALENDAR_CACHE[calendar_id];

    let calendar = null;
    try {
        calendar = withRetry('getCalendarById', function () {
            return CalendarApp.getCalendarById(calendar_id);
        });
    } catch (e) {
        console.error('[GCal] Could not open calendar %s: %s', calendar_id, (e && e.message) || e);
    }

    if (!calendar) console.error('[GCal] Calendar %s is not accessible (wrong id or missing access).', calendar_id);

    CALENDAR_CACHE[calendar_id] = calendar;
    return calendar;
}

/**
 * Create an event in Google Calendar.
 * @returns {String|false} the new event id, or false
 */
function createEvent(target, page, event, calendar_name) {
    const calendar_id = target.calendars[calendar_name];
    const calendar = getCalendar(calendar_id);
    if (!calendar) return false;

    const summary = event.summary || '(No title)';
    const details = {
        description: event.description || '',
        location: event.location || '',
    };

    const start = event.start;
    if (!(start instanceof Date) || isNaN(start.getTime())) {
        console.error('[+GC] Page %s has an invalid start date.', page.id);
        return false;
    }

    let end = event.end instanceof Date && !isNaN(event.end.getTime()) ? event.end : null;

    let new_event_id;
    try {
        let new_event;
        if (event.all_day) {
            if (end) {
                // Notion end date is inclusive, GCal end date is exclusive.
                const shifted = new Date(end.getTime());
                shifted.setDate(shifted.getDate() + 1);
                new_event = calendar.createAllDayEvent(summary, start, shifted, details);
            } else {
                new_event = calendar.createAllDayEvent(summary, start, details);
            }
        } else {
            if (!end || end <= start) end = new Date(start.getTime() + 30 * 60 * 1000);
            new_event = calendar.createEvent(summary, start, end, details);
        }
        new_event_id = new_event.getId().split('@')[0];
    } catch (e) {
        console.error('[+GC] Failed to create event for page %s: %s', page.id, (e && e.message) || e);
        return false;
    }

    if (!new_event_id) {
        console.log('[+GC] Event "%s" was not created in GCal.', summary);
        return false;
    }

    pushDatabaseUpdate(getBaseNotionProperties(target, new_event_id, calendar_name), page.id);
    return new_event_id;
}

/**
 * Update a Google Calendar event.
 * @returns {'OK'|'NOT_FOUND'|'ERROR'}
 */
function pushEventUpdate(event, event_id, calendar_id) {
    const calendar = getCalendar(calendar_id);
    if (!calendar) return 'ERROR';

    let cal_event;
    try {
        cal_event = withRetry('getEventById', function () {
            return calendar.getEventById(event_id);
        });
    } catch (e) {
        console.log('[+GC] Could not fetch event %s: %s', event_id, (e && e.message) || e);
        return 'NOT_FOUND';
    }

    if (!cal_event) return 'NOT_FOUND';

    const start = event.start;
    if (!(start instanceof Date) || isNaN(start.getTime())) {
        console.error('[+GC] Invalid start date for event %s.', event_id);
        return 'ERROR';
    }
    let end = event.end instanceof Date && !isNaN(event.end.getTime()) ? event.end : null;

    try {
        if (event.all_day) {
            if (end) {
                const shifted = new Date(end.getTime());
                shifted.setDate(shifted.getDate() + 1); // GCal end date is exclusive
                cal_event.setAllDayDates(start, shifted);
            } else {
                cal_event.setAllDayDate(start);
            }
        } else {
            if (!end || end <= start) end = new Date(start.getTime() + 30 * 60 * 1000);
            cal_event.setTime(start, end);
        }

        cal_event.setTitle(event.summary || '(No title)');
        cal_event.setDescription(event.description || '');
        cal_event.setLocation(event.location || '');
        return 'OK';
    } catch (e) {
        console.error('[+GC] Failed to push update for event %s: %s', event_id, (e && e.message) || e);
        return 'ERROR';
    }
}

/**
 * Delete an event from Google Calendar
 * @returns {Boolean} true if the event is gone afterwards
 */
function deleteEvent(event_id, calendar_id) {
    if (!event_id || !calendar_id) {
        console.log('[-GCal] Missing event id or calendar id, nothing to delete.');
        return false;
    }

    console.log('[-GCal] Deleting event %s from calendar %s', event_id, calendar_id);
    const calendar = getCalendar(calendar_id);
    if (!calendar) return false;

    try {
        const cal_event = calendar.getEventById(event_id);
        if (!cal_event) {
            console.log('[-GCal] Event %s is already gone.', event_id);
            return true;
        }
        withRetry('deleteEvent', function () {
            cal_event.deleteEvent();
            return true;
        });
        return true;
    } catch (e) {
        console.log('[-GCal] Failed to delete event %s: %s', event_id, (e && e.message) || e);
        return false;
    }
}

/**
 * Error thrown when an event is invalid and cannot be pushed to either side.
 */
class InvalidEventError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidEventError';
    }
}
