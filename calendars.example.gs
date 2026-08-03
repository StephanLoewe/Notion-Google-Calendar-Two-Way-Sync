/**
 * Calendar map for the Notion <-> Google Calendar sync.
 *
 * Copy this file to `calendars.gs` and fill in your own calendar IDs.
 * `calendars.gs` is gitignored so real IDs never end up in the repository.
 *
 * The key (before ':') is the value you use in the Notion "Calendar" select
 * property. The value (after ':') is the Google calendar ID, which you find in
 * Google Calendar under Settings -> <calendar> -> Integrate calendar.
 *
 * Do NOT also declare CALENDAR_IDS in code.gs - a duplicate `const` breaks the
 * whole Apps Script project.
 */
const CALENDAR_IDS = {
    ['Tasks']: 'your-calendar-id@group.calendar.google.com',
    ['Joy / Energy']: 'your-calendar-id@group.calendar.google.com',
    ['Family']: 'your-calendar-id@group.calendar.google.com',
};
