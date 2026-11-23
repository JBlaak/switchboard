/**
 * The sidebar's two pages, side by side: the session list (`#sidebar-content`)
 * and your pull requests (`#sidebar-prs`), both in `#sidebar-pages`.
 *
 * At rest only the page the store names is shown; the other is `hidden`, so
 * it takes no focus and no layout. A two-finger swipe across the sidebar
 * shows both and moves them with the fingers, written straight onto their
 * transforms with no transition (the arithmetic is `swipe.ts`); once the wheel
 * goes quiet they settle, eased, on one page. A page change from anywhere
 * else (the switch, Cmd+P) slides the same way, from wherever the pages are.
 *
 * Outside React because a swipe is a stream of wheel events, each of which has
 * to move the pages in that same frame: a store round trip and a render per
 * event would lag the fingers. Only the page it settles on goes to the store.
 *
 * The switch's pill follows along through `--sidebar-page-progress` on
 * `#sidebar` (0 on Sessions, 1 on Pull requests); `.sidebar-pages-dragging`
 * turns its transition off while the fingers drive it.
 */
import {getState, store} from '../../state/app-store';
import {reducedMotion} from '../../lib/motion/spring';
import {showSidebarPage} from './actions';
import {
    PAGES,
    SETTLE_AFTER_MS,
    isDueToSettle,
    isSidewaysWheel,
    restingSwipe,
    settleSwipe,
    swipeOffset,
    swipeProgress,
    swipeWheel,
} from './swipe';
import type {SidebarPage} from '../../state/sidebar-page-slice';

/** Matches the pill's transition in `_sidebar-pages.scss`. */
const SLIDE_MS = 320;
const SLIDE_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/** Follow the store and the wheel. Answers a teardown. */
export function installSidebarPages(): () => void {
    const sidebar = document.getElementById('sidebar')!;
    const pages = document.getElementById('sidebar-pages')!;
    const pageElements: Record<SidebarPage, HTMLElement> = {
        sessions: document.getElementById('sidebar-content')!,
        pullRequests: document.getElementById('sidebar-prs')!,
    };
    const all = Object.values(pageElements);

    let swipe = restingSwipe(getState().sidebarPage.page);
    /** The page shown at rest, or the one a slide is on its way from. */
    let shown: SidebarPage = swipe.page;
    /** Where the pages are drawn while they are moving; null at rest. */
    let movingX: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let slideTimer: ReturnType<typeof setTimeout> | null = null;

    const width = (): number => pages.clientWidth;
    /** The pages' x when `page` is the one in view: the pages sit left to right, each a sidebar wide. */
    const restingX = (page: SidebarPage): number => -PAGES.indexOf(page) * width();
    const setProgress = (progress: number): void =>
        sidebar.style.setProperty('--sidebar-page-progress', String(progress));

    function place(x: number, transition: string): void {
        movingX = x;
        for (const element of all) {
            element.hidden = false;
            element.style.transition = transition;
            element.style.transform = `translateX(${x}px)`;
        }
    }

    /** Where the pages are drawn right now: mid-slide, between where it left and where it goes. */
    function currentX(): number {
        if (movingX === null) return restingX(shown);
        if (slideTimer === null) return movingX;
        return new DOMMatrixReadOnly(getComputedStyle(pageElements.sessions).transform).m41;
    }

    function rest(page: SidebarPage): void {
        if (slideTimer !== null) clearTimeout(slideTimer);
        slideTimer = null;
        movingX = null;
        shown = page;
        for (const p of PAGES) {
            const element = pageElements[p];
            element.style.transition = '';
            element.style.transform = '';
            element.hidden = p !== page;
        }
        sidebar.classList.remove('sidebar-pages-dragging');
        setProgress(PAGES.indexOf(page));
    }

    /** Ease the pages from wherever they are onto `page`. */
    function slideTo(page: SidebarPage): void {
        const collapsed = getState().toolbar.sidebarCollapsed;
        if (reducedMotion() || collapsed || width() === 0) {
            rest(page);
            return;
        }
        const from = currentX();
        if (slideTimer !== null) clearTimeout(slideTimer);
        place(from, 'none');
        // Laid out at `from` before the transition starts, or it would start from the resting layout.
        void pages.offsetWidth;
        place(restingX(page), `transform ${SLIDE_MS}ms ${SLIDE_EASE}`);
        sidebar.classList.remove('sidebar-pages-dragging');
        setProgress(PAGES.indexOf(page));
        slideTimer = setTimeout(() => rest(page), SLIDE_MS);
    }

    function settle(): void {
        settleTimer = null;
        const now = performance.now();
        if (!isDueToSettle(swipe, now)) {
            settleTimer = setTimeout(settle, SETTLE_AFTER_MS);
            return;
        }
        const settled = settleSwipe(swipe, width(), now);
        swipe = settled.swipe;
        // A flip goes through the store, whose follow-up below slides the pages; a spring back stays here.
        if (settled.flipped) showSidebarPage(settled.page);
        else slideTo(settled.page);
    }

    function onWheel(e: WheelEvent): void {
        // A pinch arrives as a wheel with Ctrl held; on the rail there are no pages to move.
        if (e.ctrlKey || getState().toolbar.sidebarCollapsed || !isSidewaysWheel(e)) return;
        e.preventDefault();
        const next = swipeWheel(swipe, {deltaX: e.deltaX, deltaY: e.deltaY, at: e.timeStamp});
        if (next === swipe) return;
        swipe = next;
        if (slideTimer !== null) clearTimeout(slideTimer);
        slideTimer = null;
        sidebar.classList.add('sidebar-pages-dragging');
        place(restingX(swipe.page) + swipeOffset(swipe, width()), 'none');
        setProgress(swipeProgress(swipe, width()));
        if (settleTimer !== null) clearTimeout(settleTimer);
        settleTimer = setTimeout(settle, SETTLE_AFTER_MS);
    }

    const unsubscribe = store.subscribe((state, previous) => {
        const page = state.sidebarPage.page;
        if (page === previous.sidebarPage.page) return;
        // From the switch or Cmd+P, maybe mid-swipe: that swipe is over.
        if (swipe.page !== page) {
            if (settleTimer !== null) clearTimeout(settleTimer);
            settleTimer = null;
            swipe = restingSwipe(page);
        }
        slideTo(page);
    });

    sidebar.addEventListener('wheel', onWheel, {passive: false});
    rest(shown);

    return () => {
        unsubscribe();
        sidebar.removeEventListener('wheel', onWheel);
        if (settleTimer !== null) clearTimeout(settleTimer);
        if (slideTimer !== null) clearTimeout(slideTimer);
    };
}
