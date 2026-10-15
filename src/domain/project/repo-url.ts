/**
 * The web page for a git remote.
 *
 * A remote comes in three shapes — `git@host:owner/repo.git`,
 * `ssh://git@host[:port]/owner/repo.git` and `https://host/owner/repo.git` —
 * and GitHub, GitLab and Bitbucket all serve the repository's page at
 * `https://host/owner/repo`. Anything else (a local path, `file://`) has no
 * page, and answers null.
 */
export function repoWebUrl(remote: string): string | null {
  const trimmed = remote.trim();

  const scp = trimmed.match(/^[^@/\s]+@([^:/\s]+):(?!\/)(.+)$/);
  if (scp) return build(scp[1], scp[2]);

  const url = trimmed.match(/^(?:ssh|git|https?):\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/(.+)$/i);
  if (url) return build(url[1], url[2]);

  return null;
}

function build(host: string, repoPath: string): string | null {
  const clean = repoPath.replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!clean || clean.split('/').some(part => !part)) return null;
  return `https://${host}/${clean}`;
}
