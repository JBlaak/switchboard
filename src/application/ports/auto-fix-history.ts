/**
 * What auto-fix has done to each PR's checks, kept across restarts (W3).
 *
 * A failing check is handed to Claude once until it goes green, and that only
 * holds if a restart does not forget it: every hand-over and every check going
 * green is a stored row.
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
    | {kind: 'passed'; repository: string; number: number; checkName: string; at: string};

export interface AutoFixHistory {
    record(event: AutoFixRecord): void;

    /** Everything recorded for one PR, oldest first. */
    forPullRequest(repository: string, number: number): AutoFixRecord[];
}
