/**
 * The activity statistics the Claude CLI writes.
 *
 * `/stats` renders a report and leaves a cache file behind; this is that file.
 * Left as an open record rather than pinned to a schema: it is the CLI's file,
 * and its shape is the CLI's to change. Readers narrow each field they want.
 */
export type StatsData = Record<string, unknown>;
