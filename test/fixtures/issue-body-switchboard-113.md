Part of #112. Wave 1. Decisions: I3–I5, L2, L3, L5.

Find the images in a local diff, record how big each side is, and serve their bytes over IPC.

## What
- **`src/domain/session-work/image.ts`**: `ImageFormat`, `imageFormatOf(path)` (matched by extension, case-insensitive; `.jpg` and `.jpeg` are both `jpeg`), and `IMAGE_AUTO_LOAD_BYTES`.
- **`FileDiff.image?: FileImage`** in `model.ts`, as in the epic's contracts. SVG is a text file in the diff, so it keeps its hunks and gains `image` too.
- **Git port** (`git-workspace.ts` and `git-cli-workspace.ts`), added as needed:
  - the merge-base commit of `branch` and `base`;
  - the size of a blob at a revision and path (batch these with `git cat-file --batch-check`);
  - a blob's bytes at a revision and path (`git show <rev>:<path>` as a Buffer, or null when it is missing).
- **`SessionWorkService`**: after parsing a **local** diff, annotate each image file:
  - for a branch: before = merge-base, after = the head commit the diff was cached against;
  - for uncommitted changes: before = HEAD, after = the file on disk;
  - added: before null; deleted: after null; renamed or copied: before reads `oldPath`.

  A diff from GitHub gets no `image`. Make sure the annotation is part of what is cached, so the cache key still describes it.
- **`image(sessionId, itemId, path, side)`** on the service returns the bytes, or null. It serves only a path that is in that item's current local diff, read at the revisions that diff was made from (L3). Never trust a revision or path from the renderer beyond picking a file in that list.
- **IPC**: `INVOKE.sessionWorkImage`, a handler in `session-work-handlers.ts`, the preload bridge, and `api.ts`. Bytes travel as `Uint8Array`.

## Not here
No renderer UI. #115 uses `file.image` and the IPC call.

## Tests
- `imageFormatOf` across every format, upper case, and non-images.
- Service with a fake git: annotation for branch, uncommitted, added, deleted, renamed and GitHub-sourced diffs. `image()` refuses a path outside the diff and reads the right revision for each side.
- `git-cli-workspace` against a real temporary repo, following the existing test file: blob sizes, blob bytes and merge-base.

