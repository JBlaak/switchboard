/**
 * Transcript lines, shaped like the ones Claude CLI writes.
 *
 * The app's parser (src/domain/session/transcript.ts) only reads a handful of
 * fields — `type`, `timestamp`, `cwd`, `slug`, `message`, the title and
 * `pr-link` records — but the lines here carry the rest of what a real CLI
 * line has too (`uuid`, `parentUuid`, `version`, `gitBranch`, …), so a parser
 * change that starts depending on one of them is exercised rather than
 * silently passing against a thinned-out fixture.
 */
import crypto from 'node:crypto';

/** The CLI version fixture lines claim to come from. */
const CLI_VERSION = '2.1.301';

/** A pull request the session opened, as a fixture states it. */
export interface FixturePullRequest {
  number: number;
  /** `owner/repo`. */
  repository: string;
}

/** What one session's transcript should say. */
export interface TranscriptSpec {
  sessionId: string;
  cwd: string;
  /** The first user message: the row label until something better exists. */
  prompt: string;
  /** Epoch ms of the first message. */
  startedAt: number;
  /** Epoch ms of the last message — the row's "modified" time. */
  endedAt: number;
  /** User and assistant entries in total, alternating; at least 1. */
  messages: number;
  slug?: string;
  aiTitle?: string;
  /** What `/rename` writes into the transcript itself. */
  customTitle?: string;
  pullRequests?: readonly FixturePullRequest[];
  /** Set when this transcript was started with `--fork-session` from another. */
  forkedFrom?: string;
  gitBranch?: string;
}

/**
 * Every line of one transcript, oldest first.
 *
 * Message timestamps are spread evenly between `startedAt` and `endedAt`, so
 * the parser's first/last timestamp — and with them the row's time label —
 * are exactly the ones the fixture asked for.
 */
export function transcriptLines(spec: TranscriptSpec): Record<string, unknown>[] {
  const count = Math.max(1, spec.messages);
  const step = count > 1 ? (spec.endedAt - spec.startedAt) / (count - 1) : 0;
  const at = (i: number): string => new Date(Math.round(spec.startedAt + step * i)).toISOString();

  const common = {
    isSidechain: false,
    userType: 'external',
    cwd: spec.cwd,
    sessionId: spec.sessionId,
    version: CLI_VERSION,
    gitBranch: spec.gitBranch ?? 'main',
    ...(spec.slug ? { slug: spec.slug } : {}),
  };

  const lines: Record<string, unknown>[] = [
    // The CLI opens every transcript with one of these; it has no cwd, which is
    // why the app's cwd lookup has to look past the first line.
    {
      type: 'file-history-snapshot',
      messageId: stableUuid(spec.sessionId, 'snapshot'),
      snapshot: { messageId: stableUuid(spec.sessionId, 'snapshot'), trackedFileBackups: {}, timestamp: at(0) },
      isSnapshotUpdate: false,
    },
  ];

  let parentUuid: string | null = null;
  for (let i = 0; i < count; i++) {
    const uuid = stableUuid(spec.sessionId, 'message-' + i);
    const isUser = i % 2 === 0;
    const line: Record<string, unknown> = {
      parentUuid,
      ...common,
      type: isUser ? 'user' : 'assistant',
      uuid,
      timestamp: at(i),
      message: isUser
        ? { role: 'user', content: i === 0 ? spec.prompt : `Follow-up ${i / 2} on: ${spec.prompt}` }
        : {
          id: 'msg_' + stableUuid(spec.sessionId, 'msg-' + i).replace(/-/g, '').slice(0, 24),
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-5',
          content: [{ type: 'text', text: `Working on it (step ${(i + 1) / 2}).` }],
          stop_reason: 'end_turn',
        },
    };
    if (i === 0 && spec.forkedFrom) {
      line.forkedFrom = { sessionId: spec.forkedFrom, messageUuid: stableUuid(spec.forkedFrom, 'fork') };
    }
    lines.push(line);
    parentUuid = uuid;
  }

  for (const pr of spec.pullRequests ?? []) {
    lines.push({
      type: 'pr-link',
      sessionId: spec.sessionId,
      prNumber: pr.number,
      prUrl: `https://github.com/${pr.repository}/pull/${pr.number}`,
      prRepository: pr.repository,
      timestamp: at(count - 1),
    });
  }

  // Untimestamped bookkeeping records, as the CLI appends on exit and resume.
  if (spec.aiTitle) lines.push({ type: 'ai-title', aiTitle: spec.aiTitle, sessionId: spec.sessionId });
  if (spec.customTitle) {
    lines.push({ type: 'custom-title', customTitle: spec.customTitle, sessionId: spec.sessionId });
  }
  lines.push({ type: 'last-prompt', lastPrompt: spec.prompt, sessionId: spec.sessionId });

  return lines;
}

/**
 * A UUID-shaped id that is the same on every run.
 *
 * Session ids show up in the sidebar and the terminal header, so a random one
 * would make every screenshot differ.
 */
export function stableUuid(...parts: string[]): string {
  const hex = crypto.createHash('sha1').update(parts.join('\0')).digest('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), '4' + hex.slice(13, 16), '8' + hex.slice(17, 20), hex.slice(20, 32)].join('-');
}
