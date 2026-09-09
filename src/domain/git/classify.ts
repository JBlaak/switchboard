/**
 * Which changed files are worth reading, and which are noise.
 *
 * A session that installs one dependency leaves a diff whose honest summary is
 * "one line in package.json" and whose actual size is twelve thousand lines of
 * `package-lock.json`. Rendering that is not wrong so much as useless: the file
 * nobody will read pushes the file everybody wants off the screen. So generated
 * files are collapsed behind a banner and oversized ones behind an `Expand`,
 * and these are the rules that decide which is which.
 *
 * Collapsed, never dropped. Every rule here is a guess about intent — a
 * committed `build/` directory is somebody's real source — so each one has to
 * be reversible from the surface, and none of them may change what the numbers
 * say. The count in the header is of everything that changed.
 *
 * Pure and pattern-based, with one exception that is not a guess at all: a
 * `.gitattributes` marking a path `linguist-generated` is the repository
 * telling us directly, and it wins.
 */

/** Does the repository itself call this path generated? */
export type GeneratedAttributes = (path: string) => boolean;

/**
 * Lockfiles: written by a tool, read by a tool, and the single biggest source
 * of diff noise in this app's world. Named individually as well as caught by
 * the `.lock` suffix below so the list reads as what it is.
 */
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
]);

/**
 * Build output, wherever it sits: no repository uses one of these as a source
 * directory, so a match at any depth is safe and catches the monorepo shape
 * (`packages/ui/dist/index.js`).
 */
const BUILD_DIRS = new Set(['dist', 'out', '.next', '.nuxt', 'coverage', 'node_modules']);

/**
 * Build output, but only at the top.
 *
 * `build` and `app` are ordinary names for real source — this very repository
 * keeps its icons in `build/` and its renderer bootstrap in
 * `src/renderer/app/` — and they are only reliably output when they sit at the
 * root, which is where a bundler puts them. Deeper down, the benefit of the
 * doubt goes to the source.
 */
const BUILD_ROOTS = new Set(['build', 'app']);

/** A bundle is a file whose lines were never typed. */
const BUNDLE_SUFFIXES = ['.min.js', '.min.css', '-bundle.js', '.bundle.js', '.min.map'];

/** The default for `isOversized`: more changed lines than anyone reads in one screenful of scrolling. */
export const OVERSIZE_LINES = 500;

/**
 * Is this a file whose diff nobody wants by default?
 *
 * `attributes` is the matcher `parseGitattributesGenerated` built from the
 * worktree's `.gitattributes`, when there is one to read — a remote worktree or
 * a repository without the file simply does not pass one, and the path rules
 * still apply.
 */
export function isGenerated(path: string, attributes?: GeneratedAttributes | null): boolean {
  if (attributes?.(path)) return true;

  const segments = path.split('/').filter(Boolean);
  const name = segments[segments.length - 1] ?? '';

  if (LOCKFILES.has(name) || name.endsWith('.lock')) return true;
  if (BUNDLE_SUFFIXES.some(suffix => name.endsWith(suffix))) return true;
  if (segments.slice(0, -1).some(segment => BUILD_DIRS.has(segment))) return true;
  if (segments.length > 1 && BUILD_ROOTS.has(segments[0])) return true;
  return false;
}

/**
 * Is the change too big to render unasked?
 *
 * Additions plus deletions, because a file whose 600 lines were replaced by 600
 * others is exactly as long to draw as one that grew by 1,200. The threshold is
 * a parameter so a caller — a setting, a test — can move it, not because there
 * is a principled number: 500 is roughly where a file stops being something you
 * read and starts being something you search.
 */
export function isOversized(
  entry: { additions: number; deletions: number },
  limit: number = OVERSIZE_LINES,
): boolean {
  return entry.additions + entry.deletions > limit;
}

/**
 * A `.gitattributes` file as a matcher for `linguist-generated`.
 *
 * The attribute is GitHub's, and it has become the portable way for a
 * repository to say "this file is output" — worth honouring because it is the
 * one signal here that is not a heuristic.
 *
 * The patterns follow gitignore's rules, which matter in three ways: a pattern
 * with no slash matches the *basename* at any depth (`*.min.js` covers
 * `web/js/app.min.js`), one with a slash is anchored to the repository root
 * (only the root file is read, which is where the anchor points), and `**`
 * spans directories while `*` stops at one. Later lines win over earlier ones,
 * so an unset (`-linguist-generated`) can carve an exception out of a broad
 * rule above it.
 *
 * Returns a matcher rather than a list because it is consulted once per
 * changed file: the patterns are compiled once, here, and not per lookup.
 */
export function parseGitattributesGenerated(text: string): GeneratedAttributes {
  const rules: { match: RegExp; generated: boolean }[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;

    const [pattern, rest] = splitPattern(line);
    if (!pattern) continue;

    let generated: boolean | null = null;
    for (const attribute of rest) {
      if (attribute === 'linguist-generated' || attribute === 'linguist-generated=true') generated = true;
      else if (attribute === '-linguist-generated' || attribute === 'linguist-generated=false') generated = false;
      // `!linguist-generated` makes the attribute unspecified, which is what it
      // already is unless a line above set it — so it reads as "not generated".
      else if (attribute === '!linguist-generated') generated = false;
    }
    if (generated === null) continue;

    rules.push({ match: patternToRegExp(pattern), generated });
  }

  if (rules.length === 0) return () => false;

  return (path: string): boolean => {
    let generated = false;
    // Last match wins, so the whole list is walked rather than stopped at the
    // first hit.
    for (const rule of rules) if (rule.match.test(path)) generated = rule.generated;
    return generated;
  };
}

/**
 * A `.gitattributes` line as its pattern and its attributes.
 *
 * The pattern may be quoted, which is how a pattern with a space in it is
 * written; unquoted, whitespace separates it from the attributes.
 */
function splitPattern(line: string): [string, string[]] {
  if (line.startsWith('"')) {
    const end = line.indexOf('"', 1);
    if (end < 0) return ['', []];
    return [line.slice(1, end), line.slice(end + 1).split(/\s+/).filter(Boolean)];
  }
  const parts = line.split(/\s+/).filter(Boolean);
  return [parts[0] ?? '', parts.slice(1)];
}

/**
 * A gitignore-shaped pattern as a regular expression over a repository-relative
 * path.
 *
 * Built per segment, because that is where the difference between `*` and `**`
 * lives: `*` may not cross a separator, `**` may, and a `**` between two
 * separators matches no directory at all (`a/**\/b` covers `a/b`).
 */
function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.slice(0, -1).includes('/');
  const body = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  const segments = body.replace(/\/$/, '').split('/');

  let expression = '';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      // Trailing, it swallows the rest of the path; in the middle it swallows
      // whole directories, its own separator included, or none of them.
      expression += last ? '.*' : '(?:[^/]+/)*';
    } else {
      expression += segmentToRegExp(segment) + (last ? '' : '/');
    }
  });

  // A pattern that ends in `/` names a directory, so everything under it
  // matches too; so does one that named a directory without the slash.
  const suffix = pattern.endsWith('/') ? '/.*' : '(?:/.*)?';
  return new RegExp(anchored ? `^${expression}${suffix}$` : `(?:^|/)${expression}${suffix}$`);
}

/** One path segment: `*` and `?` stop at the separator, a class stays a class. */
function segmentToRegExp(segment: string): string {
  let expression = '';
  for (let i = 0; i < segment.length; i++) {
    const character = segment[i];
    if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else if (character === '[') {
      const end = segment.indexOf(']', i + 1);
      if (end < 0) {
        expression += '\\[';
      } else {
        const body = segment.slice(i + 1, end).replace(/^!/, '^');
        expression += `[${body}]`;
        i = end;
      }
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return expression;
}
