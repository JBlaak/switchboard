/**
 * The user's MCP servers, as Claude Code keeps them in `~/.claude.json` (C2).
 *
 * A capture gets one server's entry, copied unchanged into a file of its own
 * in the temp directory, mode 0600, under a fresh name, so the header form
 * (`headers.Authorization: Bearer …`) reaches `--mcp-config` as the CLI wrote
 * it (#144). Nothing here logs what it read: the entry holds the token.
 *
 * `~/.claude.json` is read afresh each time. It is the CLI's file and changes
 * under us, and a server added in Claude Code should work on the next capture.
 */
import { mcpServerConfig, mcpServerHeaders } from '../../domain/ask/capture';
import type { FileSystem } from '../../application/ports/file-system';
import type { IdGenerator } from '../../application/ports/ids';
import type { Logger } from '../../application/ports/logger';
import type { McpConfigFile, McpServers } from '../../application/ports/mcp-servers';

export interface ClaudeJsonMcpServersDeps {
  fs: FileSystem;
  homeDir: string;
  /** Where the config files go: the user's own temp directory. */
  tempDir: string;
  ids: IdGenerator;
  log: Logger;
}

export class ClaudeJsonMcpServers implements McpServers {
  readonly #written = new Set<string>();

  constructor(private readonly deps: ClaudeJsonMcpServersDeps) {}

  has(name: string): boolean {
    return this.#config(name) !== null;
  }

  write(name: string): McpConfigFile | null {
    const config = this.#config(name);
    if (!config) return null;
    const { fs, tempDir, ids } = this.deps;
    const path = fs.join(tempDir, `switchboard-mcp-${ids.newId()}.json`);
    this.#written.add(path);
    try {
      fs.writeText(path, JSON.stringify(config), { mode: 0o600 });
    } catch (err) {
      this.#remove(path);
      throw err;
    }
    return { path, remove: () => this.#remove(path) };
  }

  headersFor(url: string): Record<string, string> | null {
    const claudeJson = this.#claudeJson();
    return claudeJson === null ? null : mcpServerHeaders(claudeJson, url);
  }

  removeAll(): void {
    for (const path of [...this.#written]) this.#remove(path);
  }

  /** The `--mcp-config` content for `name`, or null when it isn't set up or the file can't be read. */
  #config(name: string): ReturnType<typeof mcpServerConfig> {
    const claudeJson = this.#claudeJson();
    return claudeJson === null ? null : mcpServerConfig(claudeJson, name);
  }

  /** `~/.claude.json`, parsed, or null when it isn't there or can't be read. */
  #claudeJson(): unknown {
    const { fs, homeDir, log } = this.deps;
    const file = fs.join(homeDir, '.claude.json');
    if (!fs.exists(file)) return null;
    try {
      return JSON.parse(fs.readText(file)) as unknown;
    } catch {
      // Only that it failed: the message could quote the file.
      log.warn('[mcp-servers] could not read ~/.claude.json');
      return null;
    }
  }

  #remove(path: string): void {
    this.#written.delete(path);
    try {
      this.deps.fs.remove(path);
    } catch (err) {
      this.deps.log.warn('[quick-ask] could not remove an MCP config:', (err as Error).message);
    }
  }
}
