/**
 * A session showing the user a page, through Switchboard's `show_page` tool.
 *
 * Unlike an archive, there is nothing to wait for: the page goes to the window
 * at once, filed under the session's current id, and the window lays it over
 * that session's terminal. The window keeps it; main forgets it as soon as it
 * is sent.
 */
import type {ArchiveToolOutcome} from '../../domain/session/archive-tool';
import type {PageInput} from '../../domain/session/page-tool';
import type {SessionRegistry} from '../model/session-registry';
import type {Clock} from '../ports/clock';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';

export interface PageToolServiceDeps {
    registry: SessionRegistry;
    renderer: Pick<RendererGateway, 'attached' | 'pageShown'>;
    clock: Clock;
    log: Logger;
}

export class PageToolService {
    constructor(private readonly deps: PageToolServiceDeps) {}

    /** The session launched as `launchId` asked to show `page`. */
    public show(launchId: string, page: PageInput): ArchiveToolOutcome {
        const found = this.deps.registry.find(launchId);
        if (!found) return {ok: false, message: 'Switchboard has no running session by this id, so nothing was shown.'};
        if (!this.deps.renderer.attached) {
            return {ok: false, message: 'No Switchboard window is open to show the page in.'};
        }
        const sessionId = found.session.realSessionId || found.key;
        this.deps.renderer.pageShown({sessionId, title: page.title, html: page.html, shownAt: this.deps.clock.now()});
        this.deps.log.info(`[page-tool] session=${sessionId} showed "${page.title}" (${page.html.length} chars)`);
        return {
            ok: true,
            message:
                "The page is open in Switchboard, over this session's terminal. The user closes it with Esc " +
                'and can reopen it from the terminal header.',
        };
    }
}
