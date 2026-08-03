/**
 * Sync targets for the Notion <-> Google Calendar sync.
 *
 * Copy this file to `targets.gs` and fill in your own ids.
 * `targets.gs` is gitignored so real ids never end up in the repository.
 *
 * Each entry is one Notion database plus the calendars it owns.
 *
 *   - a database may own any number of calendars
 *   - a calendar must belong to exactly one database, otherwise a new event
 *     coming from Google Calendar would have no deterministic home.
 *     Violations are reported at startup with the offending calendar id.
 *
 * `name` is only used in log output, pick whatever reads well.
 * `database_id` accepts the full Notion URL or the bare 32 character id.
 * Calendar ids are in Google Calendar under Settings -> <calendar> ->
 * Integrate calendar.
 *
 * Do NOT declare SYNC_TARGETS in code.gs as well - a duplicate `const` breaks
 * the whole Apps Script project.
 *
 * Run showConfiguration() by hand after editing to verify what the script sees.
 */
const SYNC_TARGETS = [
    {
        name: 'Planner',
        database_id: 'https://www.notion.so/your-workspace/0123456789abcdef0123456789abcdef',
        // Every calendar id must be distinct - the same id twice is a config
        // error and the script says so at startup.
        calendars: {
            ['Tasks']: 'your-tasks-calendar-id@group.calendar.google.com',
            ['Joy / Energy']: 'your-energy-calendar-id@group.calendar.google.com',
            ['Family']: 'your-family-calendar-id@group.calendar.google.com',
        },
    },
    {
        name: 'Arbeit',
        database_id: 'https://www.notion.so/your-workspace/fedcba9876543210fedcba9876543210',
        calendars: {
            ['Jour Fixe']: 'your-work-calendar-id@group.calendar.google.com',
        },
    },
];
