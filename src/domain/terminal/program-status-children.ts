/**
 * Which agents a session has working, read off OSC 7501's child records.
 *
 * The Program Status Protocol lets a program report more than itself: a report
 * with an `id` is a child record, and Claude CLI (2.1.301) gives every running
 * subagent one, titled with the subagent's task. Counting those is how the
 * sidebar can say "three agents are on this" without reading the transcript.
 *
 * The protocol's rules for the record set are small and kept exactly:
 *
 *   - a report replaces its record wholesale — a later report without a title
 *     has no title;
 *   - `clear` with an id removes that record and every descendant, where `a/b`
 *     is a child of `a`;
 *   - `clear` without an id removes everything (the CLI sends it on exit).
 *
 * The root record — a report without an id — is the session itself, which
 * `CliBusyTracker` follows; it is not an agent and is ignored here.
 *
 * Kept apart from `CliBusyTracker` because the two answer different questions
 * from the same stream, and either is easier to test without the other.
 */
import type { ProgramStatusReport, ProgramStatusState } from './osc';

/** One agent the session has working. */
export interface WorkingAgent {
  /** The record's slash path, e.g. `a2b4e2746e65ed41b` or `a/b` for a sub-subagent. */
  id: string;
  /** What it is doing, when the CLI said. */
  title?: string;
}

/**
 * The states that mean an agent is still on the job.
 *
 * `blocked` counts: an agent waiting on a permission prompt has not finished,
 * it is stalled mid-task, and dropping it from the count would make the number
 * flicker every time one asks for something. `idle`, `done` and `error` do
 * not: whatever the record says next, that agent is not doing anything now.
 */
const WORKING_STATES: ReadonlySet<ProgramStatusState> = new Set<ProgramStatusState>(['working', 'blocked']);

/** True when `id` is `ancestor` itself or sits somewhere beneath it. */
function isWithin(id: string, ancestor: string): boolean {
  return id === ancestor || id.startsWith(ancestor + '/');
}

function sameAgents(a: readonly WorkingAgent[], b: readonly WorkingAgent[]): boolean {
  return a.length === b.length && a.every((agent, i) => agent.id === b[i].id && agent.title === b[i].title);
}

/**
 * A session's child records, and the working agents among them.
 *
 * Like the busy tracker, `observe` answers only when the answer changed — the
 * CLI repeats reports freely — so the renderer hears about each change once.
 * Agents come out in the order their records first appeared, which keeps a
 * tooltip listing them from reshuffling as reports arrive.
 */
export class ProgramStatusChildren {
  /** id → the latest report for it. A Map keeps first-seen order through replacements. */
  readonly #records = new Map<string, { state: ProgramStatusState; title?: string }>();
  #working: readonly WorkingAgent[] = [];

  /** The agents working right now. */
  get working(): readonly WorkingAgent[] {
    return this.#working;
  }

  /** Apply one report; the new working list if it changed, else null. */
  observe(report: ProgramStatusReport): WorkingAgent[] | null {
    const { id, state } = report;

    if (state === 'clear') {
      if (id === undefined) this.#records.clear();
      else for (const key of [...this.#records.keys()]) if (isWithin(key, id)) this.#records.delete(key);
    } else if (id !== undefined) {
      this.#records.set(id, report.title === undefined ? { state } : { state, title: report.title });
    } else {
      return null;
    }

    const working: WorkingAgent[] = [];
    for (const [key, record] of this.#records) {
      if (!WORKING_STATES.has(record.state)) continue;
      working.push(record.title === undefined ? { id: key } : { id: key, title: record.title });
    }

    if (sameAgents(working, this.#working)) return null;
    this.#working = working;
    return working;
  }
}
