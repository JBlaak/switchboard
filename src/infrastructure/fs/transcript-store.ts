/**
 * `~/.claude/projects` behind the TranscriptStore port.
 *
 * Reads that the rest of the app expresses as questions about sessions —
 * "which sessions are in this folder", "has this one changed", "what project
 * does this folder belong to" — resolved against a directory the CLI owns.
 *
 * The reads are shaped by size: a transcript can be tens of megabytes, so
 * anything that only needs the head or the tail reads a slice rather than the
 * file.
 */
import { parseTranscript, cwdFromTranscript, parseTranscriptLine } from '../../domain/session/transcript';
import { encodeProjectPath, worktreeParentPath } from '../../domain/project/project-path';
import { isProjectFolderName } from './claude-paths';
import type { Session } from '../../domain/session/session';
import type { TranscriptEntry } from '../../domain/session/transcript';
import type { FileSystem } from '../../application/ports/file-system';
import type { ResolvedProject, TranscriptSeed, TranscriptStore } from '../../application/ports/transcript-store';

/**
 * How much of a transcript is read looking for a `cwd` before giving up on the
 * fast path.
 *
 * Generous, because a transcript can open with a file-history snapshot tens of
 * kilobytes long and the `cwd` is on an entry after it. When the head does not
 * carry one the whole file is read — correctness matters more here than speed:
 * a folder whose project path cannot be resolved drops out of the sidebar.
 */
const CWD_SCAN_BYTES = 65536;

/** How much is read looking for a slug. */
const SLUG_SCAN_BYTES = 8000;

export class FileTranscriptStore implements TranscriptStore {
  constructor(
    private readonly fs: FileSystem,
    private readonly projectsDir: string,
  ) {}

  listFolders(): string[] {
    if (!this.fs.exists(this.projectsDir)) return [];
    return this.fs.readDir(this.projectsDir)
      .filter(entry => entry.isDirectory && isProjectFolderName(entry.name))
      .map(entry => entry.name);
  }

  folderExists(folder: string): boolean {
    return this.fs.exists(this.#folderPath(folder));
  }

  listSessionIds(folder: string): string[] {
    try {
      return this.fs.readDir(this.#folderPath(folder))
        .filter(entry => entry.isFile && entry.name.endsWith('.jsonl'))
        .map(entry => this.fs.basename(entry.name, '.jsonl'));
    } catch {
      return [];
    }
  }

  /**
   * The project a folder's transcripts say they belong to.
   *
   * Read out of a `cwd` rather than decoded from the folder name, which is
   * lossy. Subagent transcripts live one or two directories down, and a folder
   * whose only history is a subagent run still belongs to a project — hence the
   * second pass.
   *
   * A worktree resolves to the repository it was cut from, so a `--worktree`
   * session does not appear as a project of its own next to it. The raw cwd
   * rides along, because the folder name cannot give it back: encoding is
   * lossy, and a list scoped to one worktree needs the exact directory.
   */
  resolveProjectPath(folder: string): ResolvedProject | null {
    const folderPath = this.#folderPath(folder);
    const cwd = this.#findCwd(folderPath);
    if (!cwd) return null;
    const parent = worktreeParentPath(cwd);
    return { projectPath: parent && this.fs.exists(parent) ? parent : cwd, cwd };
  }

  /**
   * The newest write anywhere in the folder.
   *
   * Transcripts are appended in place, which updates the file's mtime but
   * often leaves the containing directory's alone — so the directory's own
   * mtime is only a floor.
   */
  folderIndexMtimeMs(folder: string): number {
    const folderPath = this.#folderPath(folder);
    const dirStat = this.fs.stat(folderPath);
    if (!dirStat) return 0;

    let newest = dirStat.mtimeMs;
    try {
      for (const entry of this.fs.readDir(folderPath)) {
        if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue;
        const stat = this.fs.stat(this.fs.join(folderPath, entry.name));
        if (stat && stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    } catch {
      // Directory vanished mid-scan; the floor is still a usable answer.
    }
    return newest;
  }

  sessionFingerprint(folder: string, sessionId: string): string | null {
    return this.fs.stat(this.#sessionPath(folder, sessionId))?.modifiedIso ?? null;
  }

  sessionMtimeMs(folder: string, sessionId: string): number | null {
    return this.fs.stat(this.#sessionPath(folder, sessionId))?.mtimeMs ?? null;
  }

  readSession(folder: string, sessionId: string, projectPath: string): Session | null {
    const filePath = this.#sessionPath(folder, sessionId);
    const stat = this.fs.stat(filePath);
    if (!stat) return null;
    try {
      const lines = this.fs.readText(filePath).split('\n').filter(Boolean);
      return parseTranscript(
        lines,
        { sessionId, folder, projectPath },
        { birthtime: stat.createdIso, mtime: stat.modifiedIso });
    } catch {
      return null;
    }
  }

  readEntries(folder: string, sessionId: string): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    for (const line of this.fs.readText(this.#sessionPath(folder, sessionId)).split('\n')) {
      const entry = parseTranscriptLine(line);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  readHeadLines(folder: string, sessionId: string, byteLimit: number): string[] {
    return this.#readHead(this.#sessionPath(folder, sessionId), byteLimit)
      .split('\n')
      .filter(Boolean);
  }

  readTail(folder: string, sessionId: string, byteLimit: number): string {
    const filePath = this.#sessionPath(folder, sessionId);
    const stat = this.fs.stat(filePath);
    if (!stat) return '';
    const length = Math.min(stat.size, byteLimit);
    try {
      return this.fs.readSlice(filePath, { start: stat.size - length, length });
    } catch {
      return '';
    }
  }

  readSlug(folder: string, sessionId: string): string | null {
    for (const line of this.readHeadLines(folder, sessionId, SLUG_SCAN_BYTES)) {
      const entry = parseTranscriptLine(line);
      if (entry?.slug) return entry.slug;
    }
    return null;
  }

  ensureProjectFolder(projectPath: string, seed: TranscriptSeed): string {
    const folder = encodeProjectPath(projectPath);
    this.fs.makeDir(this.#folderPath(folder));
    if (!this.#isEmpty(folder)) return folder;

    this.seedSession(folder, seed.sessionId, [{
      type: 'user',
      cwd: projectPath,
      sessionId: seed.sessionId,
      uuid: seed.messageId,
      timestamp: seed.nowIso,
      message: { role: 'user', content: 'New project' },
    }]);
    return folder;
  }

  seedSession(folder: string, sessionId: string, lines: readonly unknown[]): void {
    const folderPath = this.#folderPath(folder);
    this.fs.makeDir(folderPath);
    const body = lines.map(line => JSON.stringify(line)).join('\n') + '\n';
    this.fs.writeText(this.#sessionPath(folder, sessionId), body);
  }

  /** True when the folder holds no transcript at all. */
  #isEmpty(folder: string): boolean {
    return this.listSessionIds(folder).length === 0;
  }

  #findCwd(folderPath: string): string | null {
    let entries;
    try {
      entries = this.fs.readDir(folderPath);
    } catch {
      return null;
    }

    // Transcripts sitting directly in the folder are the common case.
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue;
      const cwd = this.#cwdOf(this.fs.join(folderPath, entry.name));
      if (cwd) return cwd;
    }

    // Otherwise look one level down: a session directory, and inside it either
    // its own transcript or a `subagents/` directory of them.
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const subDir = this.fs.join(folderPath, entry.name);
      try {
        for (const sub of this.fs.readDir(subDir)) {
          let candidate: string | null = null;
          if (sub.isFile && sub.name.endsWith('.jsonl')) {
            candidate = this.fs.join(subDir, sub.name);
          } else if (sub.isDirectory && sub.name === 'subagents') {
            const agentDir = this.fs.join(subDir, 'subagents');
            const first = this.fs.readDir(agentDir).find(f => f.name.endsWith('.jsonl'));
            if (first) candidate = this.fs.join(agentDir, first.name);
          }
          if (!candidate) continue;
          const cwd = this.#cwdOf(candidate);
          if (cwd) return cwd;
        }
      } catch {
        // Unreadable session directory; try the next one.
      }
    }

    return null;
  }

  #cwdOf(filePath: string): string | null {
    try {
      const head = this.#readHead(filePath, CWD_SCAN_BYTES);
      const fromHead = cwdFromTranscript(head.split('\n'));
      if (fromHead) return fromHead;
      // The head was a truncated prefix, so the answer may still be further in.
      const stat = this.fs.stat(filePath);
      if (!stat || stat.size <= CWD_SCAN_BYTES) return null;
      return cwdFromTranscript(this.fs.readText(filePath).split('\n'));
    } catch {
      return null;
    }
  }

  /**
   * The first `byteLimit` bytes of a file.
   *
   * The last line is likely truncated mid-JSON; every caller parses line by
   * line and tolerates a line that will not parse.
   */
  #readHead(filePath: string, byteLimit: number): string {
    const stat = this.fs.stat(filePath);
    if (!stat) return '';
    return this.fs.readSlice(filePath, { start: 0, length: Math.min(stat.size, byteLimit) });
  }

  #folderPath(folder: string): string {
    return this.fs.join(this.projectsDir, folder);
  }

  #sessionPath(folder: string, sessionId: string): string {
    return this.fs.join(this.projectsDir, folder, sessionId + '.jsonl');
  }
}
