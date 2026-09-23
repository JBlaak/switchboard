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

export function setSidebarRefresher(fn: SidebarRefresher): void {
  sidebarRefresher = fn;
}

export function setProjectsReloader(fn: ProjectsReloader): void {
  projectsReloader = fn;
}

/** Redraw the session list from what is already in memory. */
export function refreshSidebar(options?: SidebarRefreshOptions): void {
  sidebarRefresher(options);
}

/** Re-fetch the projects from the main process, then redraw. */
export function reloadProjects(options?: SidebarRefreshOptions): Promise<void> {
  return projectsReloader(options);
}
