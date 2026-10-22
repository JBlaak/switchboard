/**
 * The plans opened recently, per project, kept in localStorage with the
 * renderer's other preferences so they outlive a restart (F1). Each plan
 * opened inside a project's page is put first (`ui/plan-page/actions`), and
 * the page opens with the latest one expanded (#174). Until #177 the New
 * Session picker still orders its plan list by it.
 *
 * The rules are pure, so they run under the node test runner; the two calls
 * at the end read and write the stored list.
 */
import { issueKeyString } from '../../../domain/plan/model';
import type { IssueKey } from '../../../domain/plan/model';
import { STORAGE_KEYS, readStored, writeStored } from '../../state/storage';
import type { ProjectPageMemory } from '../../state/project-page-slice';

/** How many recently opened plans a project remembers. */
export const RECENT_PLANS_CAP = 10;

/** Per project path, the plans opened, the latest first, as `owner/repo#n`. */
export type RecentPlans = Readonly<Record<string, readonly string[]>>;

/** The recent list as stored; anything unreadable reads as none. */
export function parseRecentPlans(raw: string | null): RecentPlans {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const recent: Record<string, string[]> = {};
    for (const [project, keys] of Object.entries(parsed)) {
      if (!Array.isArray(keys)) continue;
      const strings = keys.filter((key): key is string => typeof key === 'string');
      if (strings.length) recent[project] = strings.slice(0, RECENT_PLANS_CAP);
    }
    return recent;
  } catch {
    return {};
  }
}

/** `plan` opened in `projectPath`: first in that project's list, once, and the list kept to the cap. */
export function rememberPlan(recent: RecentPlans, projectPath: string, plan: IssueKey): RecentPlans {
  const key = issueKeyString(plan);
  const before = recent[projectPath] ?? [];
  const list = [key, ...before.filter(other => other !== key)].slice(0, RECENT_PLANS_CAP);
  return { ...recent, [projectPath]: list };
}

/** A page's memory as it opens: what it remembered, with the plan viewed last expanded too. */
export function withRecentPlan(memory: ProjectPageMemory, recent: readonly string[]): ProjectPageMemory {
  const latest = recent[0];
  if (!latest || memory.expandedPlans.includes(latest)) return memory;
  return { ...memory, expandedPlans: [...memory.expandedPlans, latest] };
}

/** The plans opened recently in `projectPath`, the latest first. */
export function recentPlansIn(projectPath: string): readonly string[] {
  return parseRecentPlans(readStored('localStorage', STORAGE_KEYS.recentPlans))[projectPath] ?? [];
}

/** Put `plan` first in `projectPath`'s recent list. */
export function recordRecentPlan(projectPath: string, plan: IssueKey): void {
  const recent = parseRecentPlans(readStored('localStorage', STORAGE_KEYS.recentPlans));
  writeStored('localStorage', STORAGE_KEYS.recentPlans, JSON.stringify(rememberPlan(recent, projectPath, plan)));
}
