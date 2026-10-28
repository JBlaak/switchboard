/**
 * The MCP servers the user set up in Claude Code, as a dependency (#142, C2).
 *
 * A capture call may reach exactly one server, from a config file holding only
 * that one. The entry is copied from `~/.claude.json`, bearer token and all, so
 * the file is the only place the token goes: never argv, a log line or the
 * renderer. It lives for one call, and whoever wrote it removes it.
 *
 * BlaakTasks (#252) is called from main directly, with the headers of the
 * entry whose URL is the one in Settings. They stay in main too.
 */

/** One server's `--mcp-config`, on disk for one call. */
export interface McpConfigFile {
  readonly path: string;
  /** Delete the file. Safe to call more than once; called in `finally`. */
  remove(): void;
}

export interface McpServers {
  /** Whether `~/.claude.json` has a server of this name. */
  has(name: string): boolean;
  /** Write a config holding only that server, readable by the user alone; null when it isn't set up (C6). */
  write(name: string): McpConfigFile | null;
  /**
   * The headers of the server whose URL is `url` (the bearer token among
   * them), or null when no server has it. `{}` for a server without headers.
   */
  headersFor(url: string): Record<string, string> | null;
  /** Delete every file still on disk, for quitting mid-call. */
  removeAll(): void;
}
