/**
 * The plans opened from the picker, per project, kept in localStorage with
 * the renderer's other preferences so they outlive a restart (F1).
 */
import { STORAGE_KEYS, readStored, writeStored } from '../../state/storage';
import { parseRecentPlans, rememberPlan } from './plan-list';
import type { IssueKey } from '../../../domain/plan/model';

/** The plans opened recently in `projectPath`, the latest first. */
export function recentPlansIn(projectPath: string): readonly string[] {
  return parseRecentPlans(readStored('localStorage', STORAGE_KEYS.recentPlans))[projectPath] ?? [];
}

/** Put `plan` first in `projectPath`'s recent list. */
export function recordRecentPlan(projectPath: string, plan: IssueKey): void {
  const recent = parseRecentPlans(readStored('localStorage', STORAGE_KEYS.recentPlans));
  writeStored('localStorage', STORAGE_KEYS.recentPlans, JSON.stringify(rememberPlan(recent, projectPath, plan)));
}
