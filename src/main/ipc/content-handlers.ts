/**
 * The three tabs that are documents rather than sessions: plans, agent files
 * and statistics — plus the search that spans them.
 */
import { INVOKE } from '../../ipc/channels';
import { SEARCH_RESULT_LIMIT } from '../../domain/search/search';
import type { SearchType } from '../../domain/search/search';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerContentHandlers(ipc: IpcRegistrar, app: Container): void {
  // ── Plans ──
  ipc.handle(INVOKE.getPlans, () => app.plans.list());
  ipc.handle(INVOKE.readPlan, (filename: string) => app.plans.read(filename));
  ipc.handle(INVOKE.savePlan, (filePath: string, content: string) => app.plans.save(filePath, content));

  // ── Agent files ──
  ipc.handle(INVOKE.getMemories, () => app.agentFiles.index());
  ipc.handle(INVOKE.readMemory, (filePath: string) => app.agentFiles.read(filePath));
  ipc.handle(INVOKE.saveMemory, (filePath: string, content: string) => app.agentFiles.save(filePath, content));

  // ── Statistics ──
  ipc.handle(INVOKE.getStats, () => app.stats.read());
  ipc.handle(INVOKE.refreshStats, () => app.stats.refresh());
  ipc.handle(INVOKE.getUsage, () => app.usage.fetch());

  // ── Search ──
  ipc.handle(INVOKE.search, (type: SearchType, query: string, titleOnly: boolean) =>
    app.searchIndex.query(type, query, SEARCH_RESULT_LIMIT, !!titleOnly));
}
