# Switchboard

Switchboard is a desktop app for running and steering many Claude Code sessions across projects. This glossary pins down the words used for its domain.

## Merging

**Merge manager**:
The Patch that owns every pull request handed to it until it merges, across all projects, and shows what is being merged.
_Avoid_: Merge bot, auto-merger, shipper

**Land**:
To hand a pull request to the Merge manager, with the intent that it merges once it is approved and green.
_Avoid_: Ship it, merge when green, auto-merge

**Lane**:
The serial line a landed pull request waits in to merge, one per repository. A repository's lane is either a queue lane or a Switchboard lane.
_Avoid_: Pipeline, train

**Queue lane**:
A lane run by the team's merge-queue Action on GitHub. Switchboard reads it and steers it only through the queue's own labels.
_Avoid_: GitHub merge queue (that is GitHub's native feature, which is not used)

**Switchboard lane**:
A lane that Switchboard runs itself, for a repository without the merge-queue Action, following the same rules as the queue.

**Lane runner**:
What coordinates a Switchboard lane: it picks the head, brings it up to date, waits for its required checks and merges it. A queue lane has no lane runner; the merge-queue Action coordinates it.
_Avoid_: Orchestrator, merge loop

**Head**:
The one pull request in a lane that is brought up to date, tested and merged. No other pull request in the lane is updated or tested.
_Avoid_: Front, current

**Held**:
A pull request that keeps its place in a lane but is passed over until it is approved or a requested review is given.
_Avoid_: Blocked, paused

**Fix errand**:
A session the Merge manager starts by itself in its own worktree to fix what stops a landed pull request (a conflict or a failed check). It pushes to the pull request's branch and archives itself.
_Avoid_: Auto-fix, Fix CI
