/**
 * The plans tab.
 *
 * Plans are markdown files the CLI writes into `~/.claude/plans` when a plan is
 * accepted. Switchboard lists them, indexes them for search, and lets the user
 * edit them in place — which is why saving is guarded: the path comes back from
 * the renderer, and only the plans directory is writable through it.
 */
import { byNewestFirst, planTitle } from '../../domain/plans/plan';
import type { PlanSummary } from '../../domain/plans/plan';
import type { FileSystem } from '../ports/file-system';
import type { Logger } from '../ports/logger';
import type { SearchIndex } from '../ports/search-index';

export interface PlanServiceDeps {
  fs: FileSystem;
  searchIndex: SearchIndex;
  log: Logger;
  /** `~/.claude/plans`. */
  plansDir: string;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
}

export class PlanService {
  constructor(private readonly deps: PlanServiceDeps) {}

  /**
   * Every plan, newest first, with the search index refreshed as a side effect.
   *
   * The index is rewritten wholesale rather than diffed: there are tens of
   * these, not thousands, and the tab is only opened by hand.
   */
  list(): PlanSummary[] {
    const { fs, plansDir, log } = this.deps;
    if (!fs.exists(plansDir)) return [];

    const plans: PlanSummary[] = [];
    const bodies = new Map<string, string>();

    try {
      for (const entry of fs.readDir(plansDir)) {
        if (!entry.isFile || !entry.name.endsWith('.md')) continue;
        const filePath = fs.join(plansDir, entry.name);
        const stat = fs.stat(filePath);
        if (!stat) continue;
        try {
          const content = fs.readText(filePath);
          plans.push({
            filename: entry.name,
            title: planTitle(content, entry.name),
            modified: stat.modifiedIso,
          });
          bodies.set(entry.name, content);
        } catch {
          // A plan being written as we read it is not worth failing the list.
        }
      }
    } catch (err) {
      log.error('[plans] could not list plans:', (err as Error).message);
      return [];
    }

    plans.sort(byNewestFirst);
    this.#reindex(plans, bodies);
    return plans;
  }

  /** One plan's content and the path to write it back to. */
  read(filename: string): { content: string; filePath: string } {
    const { fs, plansDir, log } = this.deps;
    // basename only: the filename comes from the renderer, and this is the one
    // thing stopping it from naming a file outside the plans directory.
    const filePath = fs.join(plansDir, fs.basename(filename));
    try {
      return { content: fs.readText(filePath), filePath };
    } catch (err) {
      log.error('[plans] could not read plan:', (err as Error).message);
      return { content: '', filePath: '' };
    }
  }

  save(filePath: string, content: string): SaveResult {
    const { fs, plansDir, log } = this.deps;
    const resolved = fs.resolve(filePath);
    if (!fs.isInside(plansDir, resolved)) {
      return { ok: false, error: 'path outside plans directory' };
    }
    try {
      fs.writeText(resolved, content);
      return { ok: true };
    } catch (err) {
      log.error('[plans] could not save plan:', (err as Error).message);
      return { ok: false, error: (err as Error).message };
    }
  }

  #reindex(plans: readonly PlanSummary[], bodies: ReadonlyMap<string, string>): void {
    try {
      this.deps.searchIndex.deleteType('plan');
      this.deps.searchIndex.upsert(plans.map(plan => ({
        id: plan.filename,
        type: 'plan' as const,
        folder: null,
        title: plan.title,
        body: bodies.get(plan.filename) ?? '',
      })));
    } catch (err) {
      this.deps.log.warn('[plans] could not index plans:', (err as Error).message);
    }
  }
}
