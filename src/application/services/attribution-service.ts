/**
 * Which session changed this file.
 *
 * The Changes list wants a worktree's dirty files grouped by the session that
 * changed them. Git answers *what* changed; this answers *who*, by reading the
 * file-modifying tool calls the CLI already records in every transcript. The
 * two are intersected here: a path git does not report is dropped, because a
 * `tool_use` is what the model asked for and a rejected diff or a later revert
 * leaves the claim behind.
 *
 * Two costs shape the reading. A transcript can be tens of megabytes, and a
 * project can have hundreds of them — so nothing is ever read twice:
 *
 *   - Each transcript is cached against its mtime and size. Unchanged, it costs
 *     one `stat`, the same gate `SessionIndex` uses.
 *   - Transcripts are append-only, so a changed one is read from the byte
 *     offset the last read stopped at, in bounded chunks, rather than loaded
 *     whole. The `FileSystem` port has no streaming read; `readSlice` plus a
 *     byte cursor is what it does offer, and for an append-only file that is
 *     strictly better than a stream — the bytes already parsed are never
 *     touched again.
 *
 * The reads go through `fs` rather than through `TranscriptStore` because the
 * store's reads are whole-file (`readEntries`) or head/tail slices, and because
 * a session's subagent transcripts — which hold a twentieth of all edit claims
 * and carry their parent session's id — are not among the session ids it lists.
 * Locating a project's folders is still the store's job.
 */
import { claimsForPaths, claimsFromTranscriptLine, groupClaims, resolveClaimPath } from '../../domain/attribution/claims';
import type { EditClaim, PathClaims } from '../../domain/attribution/types';
import type { DirEntry, FileSystem } from '../ports/file-system';
import type { Logger } from '../ports/logger';
import type { ResolvedProject, TranscriptStore } from '../ports/transcript-store';

export interface AttributionServiceDeps {
  fs: FileSystem;
  transcripts: TranscriptStore;
  log: Logger;
  /** `~/.claude/projects`. */
  projectsDir: string;
}

/**
 * How much of a changed transcript is read at a time.
 *
 * Chunks are cut at the last newline they contain, so a read always starts on a
 * line boundary and never lands mid-character. A single line can be larger than
 * this — a `Write` carries a whole file in its `input` — in which case the read
 * widens until the line fits.
 */
const READ_CHUNK_BYTES = 1 << 20;

/** What a transcript cost us last time, and what it said. */
interface CachedTranscript {
  mtimeMs: number;
  size: number;
  /** Byte offset just past the last complete line folded into `claims`. */
  consumed: number;
  /** The claims of every complete line before `consumed`. */
  claims: EditClaim[];
  /**
   * The claims of a final line with no newline yet.
   *
   * Reported, so the newest edit is not withheld while the CLI finishes writing
   * it, but kept out of `claims` and off the cursor so it is counted once when
   * that line is complete.
   */
  pending: EditClaim[];
}

/** A folder's project, and the gate that decides whether to look again. */
interface CachedFolder {
  indexMtimeMs: number;
  project: ResolvedProject | null;
}

export class AttributionService {
  /** Per folder, because pruning what is gone should not walk every project. */
  readonly #transcripts = new Map<string, Map<string, CachedTranscript>>();
  readonly #folders = new Map<string, CachedFolder>();
  readonly #encoder = new TextEncoder();

  constructor(private readonly deps: AttributionServiceDeps) {}

  /**
   * Who claims each of `paths`, keyed by the path as it was asked for.
   *
   * `paths` are git's changed paths, absolute or relative to `projectPath`; a
   * path no session claims is simply absent from the answer, which is the
   * "generated, not by a session" group the UI draws. `PathClaims.path` is the
   * absolute form the transcripts agreed on, which for an absolute caller is
   * the key itself.
   */
  async claimsFor(projectPath: string, paths: readonly string[]): Promise<Map<string, PathClaims>> {
    const found = new Map<string, PathClaims>();
    if (!projectPath || paths.length === 0) return found;

    const claims: EditClaim[] = [];
    for (const folder of this.#foldersFor(projectPath)) {
      for (const claim of this.#claimsInFolder(folder)) claims.push(claim);
    }
    if (claims.length === 0) return found;

    const byPath = groupClaims(claims);
    const askedFor = new Map<string, string>();
    for (const path of paths) askedFor.set(resolveClaimPath(projectPath, path), path);

    for (const [absolute, claimed] of claimsForPaths(byPath, [...askedFor.keys()])) {
      found.set(askedFor.get(absolute) ?? absolute, claimed);
    }
    return found;
  }

  /**
   * Drop every cache.
   *
   * Not needed for correctness — a transcript is re-read when its mtime or size
   * moves, and a folder that vanished is pruned on the next look — but a
   * service that holds an unbounded map of what it has read should have a way
   * to let go of it, for a project being removed or the CLI's directory being
   * replaced underneath.
   */
  forget(): void {
    this.#transcripts.clear();
    this.#folders.clear();
  }

  /**
   * The transcript folders whose sessions could have edited this project.
   *
   * A folder resolves to the repository its transcripts ran in, with a worktree
   * folded into the repository it was cut from — so scoping to a project picks
   * up its worktrees' folders too, and scoping to one worktree picks up the
   * folder whose `cwd` is that worktree.
   */
  #foldersFor(projectPath: string): string[] {
    const { fs, transcripts, log } = this.deps;
    const folders: string[] = [];
    try {
      for (const folder of transcripts.listFolders()) {
        const project = this.#projectOf(folder);
        if (!project) continue;
        if (project.projectPath === projectPath || fs.isInside(projectPath, project.cwd)) {
          folders.push(folder);
        }
      }
    } catch (err) {
      log.warn('[attribution] listing folders failed:', (err as Error).message);
    }
    return folders;
  }

  /**
   * Which project a folder belongs to, resolved once.
   *
   * A folder's name encodes the `cwd` its transcripts ran in, so the answer
   * cannot change while the name stays the same — hence the permanent cache.
   * Only "nothing readable in there yet" is worth asking again, and that is
   * gated on the folder's newest write so an unresolvable folder costs stats
   * rather than reads.
   */
  #projectOf(folder: string): ResolvedProject | null {
    const { transcripts } = this.deps;
    const known = this.#folders.get(folder);
    if (known?.project) return known.project;

    const indexMtimeMs = transcripts.folderIndexMtimeMs(folder);
    if (known && known.indexMtimeMs === indexMtimeMs) return null;

    const project = transcripts.resolveProjectPath(folder);
    this.#folders.set(folder, { indexMtimeMs, project });
    return project;
  }

  /** Every claim the folder's transcripts make, re-reading only what moved. */
  #claimsInFolder(folder: string): EditClaim[] {
    const cache = this.#transcripts.get(folder) ?? new Map<string, CachedTranscript>();
    this.#transcripts.set(folder, cache);

    const claims: EditClaim[] = [];
    const present = new Set<string>();
    for (const filePath of this.#transcriptFiles(this.deps.fs.join(this.deps.projectsDir, folder))) {
      present.add(filePath);
      for (const claim of this.#claimsInFile(filePath, cache)) claims.push(claim);
    }
    for (const filePath of cache.keys()) {
      if (!present.has(filePath)) cache.delete(filePath);
    }
    return claims;
  }

  /**
   * The transcripts under one project folder.
   *
   * The sessions themselves sit directly in it. A session that spawned
   * subagents also has a directory of its own holding their transcripts, and
   * those are worth reading: their entries carry the *parent* session's id, so
   * a subagent's edits belong to the session that spawned it — 169 of one
   * install's 3,034 edit claims, and most of a worktree-heavy session's.
   */
  #transcriptFiles(folderPath: string): string[] {
    const { fs } = this.deps;
    const files: string[] = [];

    for (const entry of this.#readDir(folderPath)) {
      if (entry.isFile) {
        if (entry.name.endsWith('.jsonl')) files.push(fs.join(folderPath, entry.name));
        continue;
      }
      if (!entry.isDirectory) continue;

      const sessionDir = fs.join(folderPath, entry.name);
      for (const sub of this.#readDir(sessionDir)) {
        if (sub.isFile && sub.name.endsWith('.jsonl')) {
          files.push(fs.join(sessionDir, sub.name));
        } else if (sub.isDirectory && sub.name === 'subagents') {
          const agentsDir = fs.join(sessionDir, 'subagents');
          for (const agent of this.#readDir(agentsDir)) {
            if (agent.isFile && agent.name.endsWith('.jsonl')) {
              files.push(fs.join(agentsDir, agent.name));
            }
          }
        }
      }
    }
    return files;
  }

  /** One transcript's claims, from the cache when its mtime and size held still. */
  #claimsInFile(filePath: string, cache: Map<string, CachedTranscript>): readonly EditClaim[] {
    const stat = this.deps.fs.stat(filePath);
    if (!stat) {
      cache.delete(filePath);
      return [];
    }

    const known = cache.get(filePath);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return reported(known);

    // Appending is the only change a transcript normally sees, and it is the
    // one worth optimising: keep what was parsed and read from where we
    // stopped. A file that shrank or changed without growing is read again from
    // the start, because nothing can be assumed about its prefix.
    const appended = known !== undefined && stat.size > known.size;
    const entry: CachedTranscript = appended
      ? { mtimeMs: stat.mtimeMs, size: stat.size, consumed: known.consumed, claims: [...known.claims], pending: [] }
      : { mtimeMs: stat.mtimeMs, size: stat.size, consumed: 0, claims: [], pending: [] };

    this.#read(filePath, entry);
    cache.set(filePath, entry);
    return reported(entry);
  }

  /** Read a transcript's unparsed bytes into `entry`, chunk by chunk. */
  #read(filePath: string, entry: CachedTranscript): void {
    const { fs, log } = this.deps;
    let cursor = entry.consumed;
    let chunkSize = READ_CHUNK_BYTES;

    try {
      while (cursor < entry.size) {
        const length = Math.min(chunkSize, entry.size - cursor);
        const chunk = fs.readSlice(filePath, { start: cursor, length });
        if (!chunk) break;

        const lastBreak = chunk.lastIndexOf('\n');
        if (lastBreak < 0) {
          // No line ended in there. At the end of the file that is the line the
          // CLI is still writing; anywhere else it is a line longer than the
          // chunk, so widen and read it again.
          if (cursor + length >= entry.size) {
            entry.pending = claimsFromTranscriptLine(chunk);
            break;
          }
          chunkSize = length * 2;
          continue;
        }

        for (const line of chunk.slice(0, lastBreak).split('\n')) {
          for (const claim of claimsFromTranscriptLine(line)) entry.claims.push(claim);
        }
        // Advance past the complete lines only; whatever followed the last
        // newline is read again next time round, when it is whole.
        cursor += this.#byteLength(chunk.slice(0, lastBreak + 1));
        entry.consumed = cursor;
        chunkSize = READ_CHUNK_BYTES;
      }
    } catch (err) {
      // A transcript being rotated or removed mid-read: keep what we parsed.
      log.debug('[attribution] reading %s stopped: %s', filePath, (err as Error).message);
    }
  }

  /**
   * How many bytes a piece of decoded text occupied.
   *
   * `readSlice` takes byte offsets and hands back a string, so the cursor has
   * to be moved by the encoded length of what was consumed — measured on the
   * complete lines, which cannot end mid-character.
   */
  #byteLength(text: string): number {
    return this.#encoder.encode(text).length;
  }

  #readDir(dirPath: string): DirEntry[] {
    try {
      return this.deps.fs.readDir(dirPath);
    } catch {
      // Gone, or never a directory. Not worth a log line: the projects
      // directory belongs to the CLI and changes under us constantly.
      return [];
    }
  }
}

/** What a cached transcript answers with: its committed claims, plus the open line's. */
function reported(entry: CachedTranscript): readonly EditClaim[] {
  return entry.pending.length ? [...entry.claims, ...entry.pending] : entry.claims;
}
