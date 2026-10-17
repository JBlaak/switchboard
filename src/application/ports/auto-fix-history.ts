/**
 * What auto-fix has done to each PR's checks, kept across restarts (W3).
 *
 * The limit of two automatic attempts per check only means something if a
 * restart does not reset it, so every attempt, every check going green and
 * every time auto-fix gave up is a stored row. An attempt names the action it
 * queued, so the CI watch can tell whether Claude still has it.
 */
export type AutoFixRecord =
  | {
    kind: 'attempt';
    repository: string;
    number: number;
    checkName: string;
    headSha: string;
    origin: 'manual' | 'auto';
    /** The stored action (`StoredAction.id`) the attempt queued. */
    activityId: string;
    /** ISO-8601. */
    at: string;
  }
  | { kind: 'passed' | 'gave-up'; repository: string; number: number; checkName: string; at: string };

export interface AutoFixHistory {
  record(event: AutoFixRecord): void;

  /** Everything recorded for one PR, oldest first. */
  forPullRequest(repository: string, number: number): AutoFixRecord[];
}
