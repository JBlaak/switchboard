/**
 * Whether a repository tags its releases (#412): the GraphQL `GhCli` sends
 * for its newest tag, and how the answer maps onto a date.
 *
 * Tags are ordered by the date of the commit they point at. An annotated
 * tag carries its own date, which is when the release was tagged; a
 * lightweight one has only its commit's. Kept apart from `gh-cli.ts`, like
 * `gh-overview.ts`, so the mapping can be tested from recorded responses.
 */

export const LATEST_TAG_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/tags/", first: 1, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      nodes {
        name
        target {
          ... on Commit { committedDate }
          ... on Tag { tagger { date } target { ... on Commit { committedDate } } }
        }
      }
    }
  }
}`;

/**
 * When the newest tag in `LATEST_TAG_QUERY`'s data was made: `{at: null}`
 * for a repository without tags, null when the data holds no repository.
 */
export function toLatestTag(data: any): {at: string | null} | null {
    const nodes = data?.repository?.refs?.nodes;
    if (!Array.isArray(nodes)) return null;
    const target = nodes[0]?.target;
    if (!target) return {at: null};
    const at = target.tagger?.date ?? target.committedDate ?? target.target?.committedDate ?? null;
    return {at: typeof at === 'string' ? at : null};
}
