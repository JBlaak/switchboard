/**
 * What the file tree agrees on.
 *
 * One entry per name in one directory, because that is how the tree is read: a
 * folder is expanded, one level is fetched, and nothing below it is touched
 * until the user asks for it. A recursive shape would invite a recursive scan,
 * and one `node_modules` in a monorepo is enough to take the main process down
 * with it.
 *
 * Deliberately not the port's `DirEntry`: that one reports what the filesystem
 * said, while this is what the tree needs — expandable or not — after the
 * service has decided that a symlink is a leaf whatever it points at.
 */

/** One name in a directory, as the tree shows it. */
export interface BrowseEntry {
  name: string;
  /** True only for a real directory: a symlink is a leaf, followed by nobody. */
  isDirectory: boolean;
  /**
   * A symlink, listed but never walked into. Always false in a remote
   * listing, which cannot tell the difference — see `BrowseService`.
   */
  isSymbolicLink: boolean;
}

/** One directory's direct children, with what git ignores already removed. */
export interface BrowseListing {
  entries: BrowseEntry[];
  /**
   * The directory could not be read — gone, or not ours to read. Reported
   * instead of thrown, so a tree that races a `git checkout` shows an empty
   * folder rather than an error.
   */
  unreadable?: boolean;
  /**
   * Why, when it could not be read.
   *
   * Carried rather than only logged because the two reasons a remote listing
   * fails read very differently to a user: a directory that is not there, and a
   * host that cannot be reached at all. `Permission denied (publickey)` under
   * `BatchMode=yes` is the common one, and rendering it as "this folder is
   * empty" would be a lie the user acts on.
   */
  error?: string;
}

/** One file's text, or why there is none. */
export interface BrowseFile {
  content?: string;
  /** Set instead of `content`: unreadable, a directory, or too large to send. */
  error?: string;
  /** Nothing can be written back — every remote read, for want of a write path. */
  readOnly?: boolean;
}
