/**
 * The usage quotas, and the full-text search over sessions.
 */
import { INVOKE } from '../../ipc/channels';
import { SEARCH_RESULT_LIMIT } from '../../domain/search/search';
import type { SearchType } from '../../domain/search/search';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerContentHandlers(ipc: IpcRegistrar, app: Container): void {
  // ── Usage ──
  ipc.handle(INVOKE.getUsage, () => app.usage.fetch());

  // ── Search ──
  ipc.handle(INVOKE.search, (type: SearchType, query: string, titleOnly: boolean) =>
    app.searchIndex.query(type, query, SEARCH_RESULT_LIMIT, !!titleOnly));
}
