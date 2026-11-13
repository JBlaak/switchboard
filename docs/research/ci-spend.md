# Where CI runs go: queue repos and repos without a queue

Research for #422 (map #420, Merge manager). Question: between a pull request being ready and it merging, where are
CI runs spent, and which of them would the Merge manager save or add?

Repos are anonymised. "Run" means one attempt of the workflow that holds the repo's required checks (a re-run is a
second attempt and counts as a run).

## Samples

| Sample | Setup | Window | Merged PRs | Runs | Runs per PR | Median green run |
| --- | --- | --- | --- | --- | --- | --- |
| Queue repo A | merge-queue Action, squash | 30 Oct – 13 Nov | 63 | 290 | 4.6 | 10.6 min |
| Queue repo B | merge-queue Action | 30 Oct – 13 Nov | 104 | 646 | 6.2 | 9.6 min |
| Queue repo B, month before its queue | AutoRebase | 22 Sep – 21 Oct | 159 | 656 | 4.1 | 4.6 min |
| AutoRebase repo C | AutoRebase | 15 Sep – 13 Nov | 61 | 216 | 3.5 | 7.8 min |
| AutoRebase repo D | AutoRebase | 17 Sep – 13 Nov | 84 | 280 | 3.3 | 8.2 min |

All five require one approval and an up-to-date branch on the trunk (repository rulesets,
`GET /repos/{o}/{r}/rulesets/{id}`: `strict_required_status_checks_policy: true`). Repos C and D got 60-day windows
because 14 days held only 6 and 2 merged PRs. A plain repo with neither queue nor AutoRebase had 2 merged PRs in
14 days and is left out. Every CI workflow cancels its previous run on a new push (`concurrency: cancel-in-progress`).

## Where the runs go

| Run started by | A | B | B before | C | D |
| --- | --- | --- | --- | --- | --- |
| First push of the PR | 63 | 104 | 159 | 61 | 84 |
| Author pushes (incl. manual "Update branch") | 111 | 374 | 384 | 102 | 182 |
| Bot rebase pushes | 96 | 95 | 106 | 33 | 8 |
| — of which the queue rebasing its head | 44 | 57 | – | – | – |
| — of which `autorebase:opt-in` before the PR was queued | 52 | 38 | 106 | 33 | 8 |
| Re-runs by people | 10 | 55 | 7 | 20 | 6 |
| Re-runs by the queue (cancelled head) | 10 | 18 | – | – | – |

| Run ended | A | B | B before | C | D |
| --- | --- | --- | --- | --- | --- |
| Passed | 175 | 308 | 409 | 138 | 162 |
| Failed | 29 | 81 | 78 | 47 | 10 |
| Cancelled by a newer push on the branch | 41 | 132 | 161 | 26 | 98 |
| Cancelled otherwise (queue, timeout, by hand) | 44 | 125 | 8 | 5 | 10 |

Sources: `GET /repos/{o}/{r}/actions/workflows/{id}/runs` (actor, triggering actor, attempt, conclusion, times),
`GET .../actions/runs/{id}/attempts/{n}` for earlier attempts, `GET /repos/{o}/{r}/issues/{n}/timeline` for labels and
reviews, `GET /repos/{o}/{r}/commits?sha=main` for trunk moves. A bot push is a run whose actor is the bot account the
queue and AutoRebase push with.

### Queue repos

- **The queue spends at most one run per merge, as designed.** Head rebases per queued merge: 44 / 59 = 0.75 in A,
  57 / 88 = 0.65 in B. The rest of the queued PRs were already up to date when they became the head. In A, 7 PRs were
  rebased twice or more as the head, because the trunk moved while their CI ran (the Action's `advanceHead` rebases
  again when a merge is refused for being behind).
- **The biggest single waste is `autorebase:opt-in` on a PR that waits a long time before it is queued.** The Action
  still rebases such PRs on every trunk move (`autorebaseOne` in `queue.ts`). In A, two PRs collected 31 and 16 bot
  rebases (47 runs, 16% of A's runs, about 1,070 runner minutes) over two weeks before anyone queued them; in B one PR
  collected 37. Without those, A drops to 3.8 runs per PR.
- **Cancelled runs are the queue's other cost.** B lost 125 runs (753 runner minutes already spent) to cancels that
  were not a newer push; A lost 44 (76 minutes, under 2 minutes each on average). Since Action v1.6.0
  (9 Nov) every pass cancels the CI of every open PR but the head's, unless it carries `ci:opt-in` (the Action's ADR
  0004, "the head gets the runners"). In B, people re-ran cancelled CI 35 times while the queue had a head, and 29 of
  those re-runs were cancelled again.
- **Opting in before approval adds no queue runs.** The Action never rebases or merges a PR without its approval
  (`waitsForReview` passes it over before any rebase). In B, 24 PRs were opted in before approval (median 3.4 hours
  before). In that time they started 83 runs, of which 3 were bot rebases; the rest were the author still pushing.
  Early opt-in PRs had fewer bot rebases (0.67 per PR) than late ones (1.22), and more runs in total (6.3 against 5.0)
  only because they were the ones still under review. In A, 62 of 63 PRs were approved on open by the auto-approve
  workflow for maintainers, so only 3 were opted in early: too few to say anything.

### Repos with AutoRebase

- **Each trunk merge sets off few runs on waiting PRs**: 0.43 bot rebase runs per trunk commit in B before its queue,
  0.54 in C, 0.10 in D. Few PRs wait with `autorebase:opt-in` (70 of 159, 23 of 61, 19 of 84 ever had it), and most of
  those got 0 or 1 rebase: in B before its queue, 116 PRs had none, 23 one, 13 two, 7 three to five, and one PR 32.
- **AutoRebase's cost is in the tail**: long-waiting labelled PRs, as in the queue repos.
- Most runs in every repo come from the author pushing: 60–95% of runs are the first push or a later author push,
  and 12–35% of runs are cancelled by the author's next push before they finish.

## What the Switchboard lane would have cost

Model, applied to each merged PR of the AutoRebase samples: keep the first push, author pushes and re-runs by people;
drop every bot rebase run (the lane never updates a waiting branch); add one run for the head update when the trunk
moved after the PR's last kept run and before it merged.

| Sample | Actual runs | Lane runs | Bot runs dropped | Head updates added | Runner minutes |
| --- | --- | --- | --- | --- | --- |
| Queue repo B before its queue | 656 | 588 (−10%) | 106 | 38 | 4,968 → 4,374 (−12%) |
| AutoRebase repo C | 216 | 195 (−10%) | 33 | 12 | 2,676 → 2,115 (−21%) |
| AutoRebase repo D | 280 | 278 (−1%) | 8 | 6 | 6,363 → 6,299 (−1%) |

The same model on the queue repos gives 290 → 211 for A and 646 → 573 for B, nearly all of it from the long-waiting
`autorebase:opt-in` PRs and from runs the queue cancelled.

## What this means for the Merge manager

1. **Merge-time CI is a minority of the spend.** In these repos the lane saves about a tenth of the runs, because few
   PRs wait with AutoRebase on. The savings grow with the number of PRs landed and waiting at once, which "Land it"
   will raise: under AutoRebase each landed waiting PR would cost a run per trunk merge; in a lane it costs at most
   one or two runs when it becomes the head.
2. **Landing early is free.** Neither the queue nor the lane rule tests a PR before it is approved, so "Land it" before
   approval (Held) costs nothing extra.
3. **`autorebase:opt-in` is the waste to stop.** In queue repos, Land should not leave a PR rebasing on every trunk
   move before it is queued; the Merge manager could show PRs that carry `autorebase:opt-in` and are not landed. This
   is the one spend Switchboard can't remove from outside the Action in queue repos without touching that label.
4. **Don't fight the queue's cancels.** The Merge manager should never re-run CI the queue cancelled on a waiting PR;
   that is the head's job when its turn comes. It can show "CI held back by the queue" and offer `ci:opt-in`.
5. **Expect one head update per merge, sometimes two.** When the trunk moves during the head's CI, the head is updated
   again (7 of 59 queued PRs in A). The Switchboard lane should expect the same.

## Guesswork and limits

- "Cancelled by a newer push" is a heuristic: a cancelled run whose end lies within 3 minutes of the next run on the
  branch. "Cancelled otherwise" lumps queue cancels with timeouts and manual cancels.
- An author's "Update branch" click or manual rebase counts as an author push; it can't be told apart from a code push
  in the run data. Merge-time spend in the AutoRebase repos is therefore undercounted, and the lane's savings could be
  larger than the table says.
- The lane model ignores ordering: it adds at most one head update per PR, does not add a second when the trunk moves
  during the head's CI (about 1 in 9 queued PRs in A), and assumes the update's run passes. It counts runs saved by
  dropping bot rebases, not minutes saved by cancelling unfinished CI on approved waiting PRs (already mostly done by
  `cancel-in-progress` in these repos).
- Approval time is mostly the auto-approve workflow's approval on open, so "before approval" means a non-maintainer
  PR or one waiting for a second look.
- Runner minutes are attempt wall-clock (`run_started_at` to `updated_at`). Repo B's CI got heavier between its two
  windows (median green run 4.6 → 9.6 minutes), so compare runs, not minutes, across them.
- Stacked PRs (base not the trunk) get no head update in the model. Only the required-check workflow is counted.
