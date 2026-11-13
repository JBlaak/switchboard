# Switchboard

Switchboard is a desktop app for running and steering many Claude Code sessions across projects. This glossary pins down the words used for its domain.

## Merging

**Merge manager**:
The Patch that owns every pull request handed to it until it merges, across all projects, and shows what is being merged.
_Avoid_: Merge bot, auto-merger, shipper

**Land**:
To hand a pull request to the Merge manager, with the intent that it merges once it is approved and green.
_Avoid_: Ship it, merge when green, auto-merge

**Unland**:
To take a landed pull request back from the Merge manager, so it leaves its lane without merging.
_Avoid_: Dequeue, cancel

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
A landed pull request that keeps its place in a lane but is passed over until it is approved, a requested review is given, or the pull request it is stacked on merges.
_Avoid_: Blocked, paused

**Waiting**:
A landed pull request with a place in its lane, waiting to become the head.
_Avoid_: Queued, pending

**Fixing**:
A landed pull request that a fix errand is working on. It keeps its place in the lane.

**Needs you**:
A landed pull request stopped by something only its author can settle, such as requested changes, an unresolved review thread or a fix errand that could not finish. It keeps its place and goes back to waiting once the cause is gone.
_Avoid_: Failed, stuck

**Merged**:
A landed pull request that has merged; the Merge manager's work on it is done.

**Fix errand**:
A session the Merge manager starts by itself in its own worktree to fix what stops a landed pull request (a conflict or a failed check). It pushes to the pull request's branch and archives itself.
_Avoid_: Auto-fix, Fix CI
