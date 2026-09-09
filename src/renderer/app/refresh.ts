/**
 * The two refreshes every feature can ask for.
 *
 * A leaf module with no imports of its own, which is what it is for: a sidebar
 * row's archive button, a dialog's project sweep and an IPC event all need to
 * say "the list changed" without importing the module that redraws it — and
 * that module needs to import them. Registering the performers here is what
 * keeps those from being import cycles.
 *
 * Deliberately just two named events rather than a general bus: anything else
 * is a direct call between the modules that actually know each other.
 */

export interface SidebarRefreshOptions {
  /**
   * Let the open session move to its true position too.
   *
   * The default keeps it parked where the user last saw it, so the list cannot
   * slide out from under the cursor while it reorders. A user-initiated action
   * (the re-sort button, a filter change) passes true.
   */
  resort?: boolean;
}

type SidebarRefresher = (options?: SidebarRefreshOptions) => void;
type ProjectsReloader = (options?: SidebarRefreshOptions) => Promise<void>;

let sidebarRefresher: SidebarRefresher = () => {};
let projectsReloader: ProjectsReloader = async () => {};
const sidebarRefreshListeners = new Set<SidebarRefresher>();

export function setSidebarRefresher(fn: SidebarRefresher): void {
  sidebarRefresher = fn;
}

export function setProjectsReloader(fn: ProjectsReloader): void {
  projectsReloader = fn;
}

/**
 * Be told each time the session list has been redrawn.
 *
 * Kept apart from `setSidebarRefresher` on purpose. There is exactly one
 * refresher because exactly one module owns the render: the sidebar decides
 * what the list shows, and a second performer would be two modules disagreeing
 * about it. Anything else that keys off the list — the project rail's
 * per-project badges, say — does not render the list; it only needs to know
 * that a redraw happened so it can derive its own view from the same stores.
 * Listeners therefore run after the refresher, once the list and whatever the
 * render recomputed reflect the new state.
 *
 * Returns the unsubscribe.
 */
export function onSidebarRefresh(listener: (options?: SidebarRefreshOptions) => void): () => void {
  sidebarRefreshListeners.add(listener);
  return () => { sidebarRefreshListeners.delete(listener); };
}

/**
 * Redraw the session list from what is already in memory, then tell the
 * listeners.
 *
 * A listener that throws is logged and skipped: an observer must never be able
 * to break the refresh it is observing, or take the listeners after it down
 * with it.
 */
export function refreshSidebar(options?: SidebarRefreshOptions): void {
  sidebarRefresher(options);
  for (const listener of [...sidebarRefreshListeners]) {
    try {
      listener(options);
    } catch (err) {
      console.error('sidebar refresh listener failed', err);
    }
  }
}

/** Re-fetch the projects from the main process, then redraw. */
export function reloadProjects(options?: SidebarRefreshOptions): Promise<void> {
  return projectsReloader(options);
}
