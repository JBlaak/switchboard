# Switchboard lane mechanics: update, test and merge the head with the fewest CI runs

Research for #421 (map #420). Vocabulary from `GLOSSARY.md` (Lane, Head, Queue lane, Switchboard lane, Held, Fix errand).
Checked on 2026-11-13 against the GitHub REST/GraphQL docs, the git docs, the live GraphQL schema (`gh api graphql` introspection) and Switchboard's code at `origin/main`.

Setting: every repo has a ruleset with **strict** required status checks ("require branches to be up to date") and **1 approval**. The Switchboard lane runs in the Mac app, signed in through the user's own `gh` (`src/infrastructure/github/gh-cli.ts`: "Switchboard never sees or stores a token"). The team's merge-queue Action, for comparison, rebases locally, pushes with `--force-with-lease` using a bot PAT so CI starts, force-cancels unfinished CI on approved waiting PRs, test-rebases waiting PRs to find conflicts, and merges through the REST merge endpoint pinning the head SHA.

## 1. Updating the head

**Recommendation:** GraphQL `updatePullRequestBranch(input: {pullRequestId, expectedHeadOid, updateMethod: REBASE})`, signed as the user through `gh`. Fall back to a fix errand (local worktree, rebase, `push --force-with-lease`) only when it refuses because of a conflict.

Facts:

- Schema (introspected): `UpdatePullRequestBranchInput` has `pullRequestId: ID!`, `expectedHeadOid: GitObjectID` ("The head ref oid for the upstream branch") and `updateMethod: PullRequestBranchUpdateMethod` ("If omitted, defaults to 'MERGE'"), enum `MERGE | REBASE`.
- REST `PUT /repos/{o}/{r}/pulls/{n}/update-branch` only merges: "by merging HEAD from the base branch into the pull request branch"; 422 when `expected_head_sha` does not match. Fine-grained permission: Pull requests, write. ([REST pulls](https://docs.github.com/en/rest/pulls/pulls), [fine-grained permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens))
- The UI's equivalent works only "when there are no merge conflicts and the branch is behind the base branch"; "Rebasing creates a linear history without a merge commit". ([Keeping your PR in sync](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/keeping-your-pull-request-in-sync-with-the-base-branch))
- **Identity and CI.** Only events caused by a workflow's `GITHUB_TOKEN` are suppressed: "events triggered by the `GITHUB_TOKEN` will not create a new workflow run"; the fix is "a GitHub App installation access token or a personal access token". ([Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)) That is why the queue Action needs a bot PAT. Switchboard calls as the signed-in user (gh's OAuth token; scopes on this machine: `repo, workflow, ...`), so **both** the API update and a local `push --force-with-lease` act as the user and each starts exactly one `pull_request: synchronize` run. No bot token is needed.
- Neither path saves a run over the other: each update costs one CI run on the head. The API path needs no clone, no worktree and no git credentials, and `expectedHeadOid` makes it race-safe like `--force-with-lease`.
- **REBASE vs MERGE.** Use REBASE to match the queue's linear history and so a squash/rebase merge stays clean. MERGE adds a merge commit to the PR branch (harmless under squash, noisy otherwise).
- **Risk, read from the rules:** `PullRequestParameters.dismissStaleReviewsOnPush` ("New, reviewable commits pushed will dismiss previous pull request review approvals") and `requireLastPushApproval` ("the most recent reviewable push must be approved by someone other than the person who pushed it"). If either is on, updating the head drops or blocks its approval: the lane would loop on Held. Switchboard should read both and warn on that repo rather than discover it by looping. Not verified: who GitHub records as committer of the rewritten commits in an API rebase; the docs do not say.

## 2. Finding conflicts for waiting PRs without pushing or checking out

**Recommendation:** `git replay --ref-action=print --onto origin/<trunk> origin/<trunk>...origin/<branch>` in a bare/shared clone (a test rebase, exactly what the queue does), with `git merge-tree --write-tree --name-only` as the fallback and to name the conflicted files.

Facts:

- `git merge-tree --write-tree`: "does not make any new commits and does not read from or write to either the working tree or index"; exit 0 clean, 1 conflicts, other = error; `--name-only` lists conflicted files. It models **one merge**, not a commit-by-commit rebase, so it can say "clean" where a rebase stops on an intermediate commit (and vice versa). ([git-merge-tree](https://git-scm.com/docs/git-merge-tree))
- `git replay`: "replays [commits] onto a new location. Leaves the working tree and the index untouched", works in bare repos; `--ref-action=print` prints `update-ref` lines instead of moving refs; exit 0 clean, 1 conflicts. It is marked **EXPERIMENTAL** ("THE BEHAVIOR MAY CHANGE"). ([git-replay](https://git-scm.com/docs/git-replay)) The Mac here has git 2.54.
- GitHub's own `mergeable`/`mergeStateStatus: DIRTY` is already in Switchboard's PR read (`gh-overview.ts`), costs nothing extra, and checks a merge (not a rebase). Good enough as a first signal; the local test rebase confirms before a fix errand starts.
- Nothing is pushed, so no CI run is spent (the queue's rule: never update a waiting branch).

## 3. Reading required checks and the strict flag; telling when the head is green

**Recommendation:** `GET /repos/{o}/{r}/rules/branches/{trunk}` (Metadata: read) for the effective rules; classic protection only as a fallback when the user is an admin. Head is green when `mergeStateStatus` is `CLEAN` (or `HAS_HOOKS`) on the `headRefOid` the lane pushed.

Facts:

- Rules for a branch "Returns all active rules that apply to the specified branch ... regardless of the level at which they are configured" (repo or org); rules in "evaluate" or "disabled" rulesets are not returned. `required_status_checks` carries `required_status_checks[{context, integration_id}]` and `strict_required_status_checks_policy`; `pull_request` carries `required_approving_review_count` and `allowed_merge_methods`. ([REST rules](https://docs.github.com/en/rest/repos/rules)) Same fields in GraphQL (`RequiredStatusChecksParameters.strictRequiredStatusChecksPolicy`, introspected).
- Classic `GET /branches/{b}/protection` needs **Administration: read**: most users cannot read it. On this public repo it answers 404 "Branch not protected" and the rules endpoint answers `[]`.
- `MergeStateStatus` (introspected): `BEHIND` "head ref is out of date", `BLOCKED`, `DIRTY` (conflicts), `UNSTABLE` "non-passing commit status", `CLEAN` "Mergeable and passing commit status", `HAS_HOOKS`, `UNKNOWN`. With strict checks, `BEHIND` = needs the update in step 1; `CLEAN` = approved, up to date and required checks green. Switchboard already reads `mergeStateStatus` and `statusCheckRollup` per PR.
- Green = every required `context` has a successful (or neutral/skipped) check run or status on `headRefOid`; wait out `UNKNOWN` (GitHub still computing). Switchboard's queue head today counts all check runs (`merge-queue.ts`, `headOf`), optional ones included; the lane should judge by the required contexts only.

## 4. Merging safely

**Recommendation:** `PUT /repos/{o}/{r}/pulls/{n}/merge` with `sha = headRefOid` that went green and a `merge_method` that the repo and the ruleset both allow. Treat 409 as "head moved, start over", 405 as "not mergeable now (behind/blocked)": re-read and update again, never retry blindly.

Facts:

- `sha`: "SHA that pull request head must match to allow merge"; 409 "if sha was provided and pull request head did not match"; 405 "if merge cannot be performed"; 422 "Validation failed, or the endpoint has been spammed". Permission: Contents, write. ([REST pulls](https://docs.github.com/en/rest/pulls/pulls)) GraphQL `mergePullRequest` has the same guard, `expectedHeadOid` ("if omitted, no check is performed").
- **When the trunk moved** after the head went green, strict checks make the PR `BEHIND`; GitHub refuses the merge (405, merge cannot be performed). The lane updates the head again: one more run. This is the cost strict checks impose; the only saving is merging promptly once green (poll cadence, section 7).
- Allowed methods = repo settings (`mergeCommitAllowed`, `squashMergeAllowed`, `rebaseMergeAllowed`; GraphQL, 1 point) ∩ ruleset `allowed_merge_methods`; `viewerDefaultMergeMethod` picks the default. This repo: merge and squash allowed, rebase not.
- New: `PUT .../merge-async` (202, outcome via `GET .../merge-async/{uuid}`, "If the PR is pushed to after the merge is requested ... the merge is cancelled"). The docs now recommend it, but the synchronous endpoint already gives the lane a clear answer per call; worth revisiting, not needed.

## 5. Cancelling unfinished CI on approved PRs waiting behind the head

**Recommendation:** `POST /repos/{o}/{r}/actions/runs/{id}/cancel` first; `force-cancel` only for a run still going a poll later. Find run ids in the same GraphQL read (`commit.checkSuites.nodes.workflowRun.databaseId`) or `GET /actions/runs?head_sha=...&status=in_progress`.

Facts:

- `cancel`: "Cancels a workflow run using its id." `force-cancel`: "bypasses conditions that would otherwise cause a workflow execution to continue" (for example `always()` jobs); "You should only use this endpoint ... when the workflow run is not responding to" cancel. Both 202/409; classic tokens need `repo`; fine-grained: **Actions, write**. ([REST workflow runs](https://docs.github.com/en/rest/actions/workflow-runs), [fine-grained permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens))
- The user needs write access to the repo; `gh`'s token here has `repo`. The queue Action goes straight to force-cancel; the docs' order (cancel, then force) lets cleanup jobs run and is still one call in the normal case.
- A cancelled run leaves a cancelled check on the waiting PR; harmless, because when it becomes the head it is updated (step 1) and the new push starts a fresh run.

## 6. Telling a queue lane from a Switchboard lane

**Recommendation:** a queue lane is a repo whose default branch has the queue's workflow: read `.github/workflows` from the default branch in GraphQL (`object(expression: "HEAD:.github/workflows")`, then the files' `Blob.text`) and look for the queue Action's `uses:` reference. Cache it (re-check every 15 min, like `QUEUE_RECHECK_MS`). Keep today's PR signal only as a fallback.

Facts:

- Today: `usesMergeQueue` in `merge-queue.ts` is true when "one of its open PRs carries a queue label or status". So a queue repo with no labelled open PR reads as **not** a queue repo; the lane would wrongly take over a PR the moment it is landed there. Not reliable enough to decide who merges.
- The workflow tree read costs 1 point (measured, folded into the lane query). The queue's labels existing in the repo (`labels(query: "automerge")`) is a cheaper hint but survives the Action being removed.

## 7. API cost per poll at a 60 s cadence

**Recommendation:** do **not** drive the lane off the project page's full PR read; give the lane its own slim GraphQL query over the landed PRs only (aliased `pullRequest(number:)`, as `gh-cli.ts` already does) and act on REST only when something changes.

Facts:

- GraphQL: "5,000 points per hour per user"; cost assumes every connection hits its `first`/`last`, divided by 100; secondary: 2,000 points/minute, 100 concurrent requests, mutations weigh 5 vs 1 for secondary limits, ~80 content-creating requests/minute. ([GraphQL rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api))
- **Measured** (`rateLimit(dryRun: true)` on this repo): the project page's `pullRequestsInQuery` shape (100 PRs × 50 check runs, 50 review threads, 20 labels, ...) costs **67 points** per repo per read. At 60 s that is ~4,000 points/hour for one repo; two repos exceed the user's 5,000. When checked, this account had already used 3,922 of 5,000 GraphQL points that hour.
- **Measured:** a slim lane query (two PRs with `headRefOid`, `mergeStateStatus`, `reviewDecision`, check rollup with run ids, plus rulesets, the workflows tree, queue labels and the trunk's oid) costs **1 point**. 60/hour per repo; ten repos 600/hour.
- REST (5,000/hour): rules for the trunk (1 call; changes rarely, so with an ETag a `304` "does not count against your primary rate limit"), cancels (1 per waiting run, only on events), update (1 GraphQL mutation per head), merge (1 per PR). ([REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api))
- Per landed PR, a lane costs roughly: 1 update mutation + 1 merge + 0–n cancels, plus 1 point/minute for the shared poll. Writes stay far under the 80/minute secondary limit.

## Not settled here

- Who is the committer of commits rewritten by an API rebase (docs silent).
- Whether queue repos' rulesets set `dismissStaleReviewsOnPush` / `requireLastPushApproval` (private; readable per repo with the rules endpoint).
- `git replay` being experimental: pin the git version it is tested against, keep `merge-tree` as fallback.
