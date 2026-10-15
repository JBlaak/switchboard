/**
 * Whether a published release is newer than the running app, and which of its
 * files this Mac would install.
 *
 * Releases are tagged `v<major>.<minor>.<patch>` and carry one zip per
 * architecture, named by electron-builder's `artifactName`:
 * `Switchboard-<version>-<arch>.zip`. The zip holds the `.app` bundle itself,
 * which is what an in-place update swaps in; the DMGs beside it are for a
 * first install by hand.
 */

export interface ReleaseAsset {
  name: string;
  url: string;
}

/** A release as GitHub publishes it, reduced to what an update needs. */
export interface PublishedRelease {
  version: string;
  pageUrl: string;
  assets: ReleaseAsset[];
}

/** What the sidebar offers: a newer version, and the zip to install it from. */
export interface AvailableUpdate {
  version: string;
  pageUrl: string;
  /** Null when the release has no zip for this architecture. */
  downloadUrl: string | null;
}

/** What the sidebar shows. */
export interface UpdateNotice {
  version: string;
  pageUrl: string;
  /** True when Install can swap the app in place; otherwise the notice links to the release. */
  installable: boolean;
}

type Version = [number, number, number];

/** `2.1.3` or `v2.1.3` as numbers; null for anything else, pre-releases included. */
export function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `candidate` is a later version than `current`; false when either is unreadable. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * The body of GitHub's `releases/latest`, or null when it is not a usable
 * release. That endpoint already skips drafts and pre-releases; they are
 * refused here as well so a different source cannot slip one through.
 */
export function parseLatestRelease(body: unknown): PublishedRelease | null {
  if (!body || typeof body !== 'object') return null;
  const release = body as Record<string, unknown>;
  if (release.draft || release.prerelease) return null;
  if (typeof release.tag_name !== 'string' || !parseVersion(release.tag_name)) return null;

  const assets: ReleaseAsset[] = [];
  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    const { name, browser_download_url: url } = (asset ?? {}) as Record<string, unknown>;
    if (typeof name === 'string' && typeof url === 'string') assets.push({ name, url });
  }

  return {
    version: release.tag_name.replace(/^v/, ''),
    pageUrl: typeof release.html_url === 'string' ? release.html_url : '',
    assets,
  };
}

/** The zip electron-builder names for this version and architecture. */
export function updateAssetName(version: string, arch: string): string {
  return `Switchboard-${version}-${arch}.zip`;
}

/** The update this release offers a Mac running `currentVersion` on `arch`, if any. */
export function availableUpdate(
  release: PublishedRelease, currentVersion: string, arch: string,
): AvailableUpdate | null {
  if (!isNewer(release.version, currentVersion)) return null;
  const wanted = updateAssetName(release.version, arch);
  const asset = release.assets.find(a => a.name === wanted);
  return { version: release.version, pageUrl: release.pageUrl, downloadUrl: asset?.url ?? null };
}
