# Contributing

How to build, test and release Switchboard. The [README](README.md) covers what the app does and how to run it.

## Setup

You need Node.js 20+ (TypeScript 7 will not load on 18), npm 10+, and the Xcode Command Line Tools
for the native modules (`xcode-select --install`).

```bash
npm install            # runs postinstall, which rebuilds the native modules
npm start              # build, then launch Electron
npm run electron       # launch again without rebuilding
npm run electron-dev   # launch against ~/.switchboard-dev instead of your real data
npm run typecheck      # tsc over the whole tree
npm test               # build, then run the unit suites in test/
```

## End-to-end tests

`e2e/` drives the built app with Playwright's Electron support. Each test gets
its own temporary `HOME` holding a fixture `~/.claude/projects`, its own
`SWITCHBOARD_DATA_DIR`, and fake `claude` and `ssh` commands on the session
shell's `PATH`, so nothing touches your real sessions or settings and no real
CLI or network is needed.

```bash
npm run test:e2e                          # build, then run the whole suite
npm run test:e2e -- e2e/tests/sidebar.spec.ts --grep "pinned"
npm run test:e2e -- --update-snapshots    # rewrite the screenshot baselines
```

The windows stay hidden and never take focus, so you can keep working while it
runs. `SB_E2E_HEADED=1` shows them, for watching a test.
`SB_E2E_SKIP_SCREENSHOTS=1` runs every functional assertion but skips the
pixel comparisons. CI does that: the baselines are rendered on a developer's
Mac, and a runner's macOS version and GPU draw text differently enough to fail
them. Run the screenshots locally before you push.

**Baselines** live in `e2e/tests/__screenshots__/<spec>/<name>-<light|dark>-darwin.png`,
one per surface and colour scheme. Update them only for an intended visual
change, look at every changed image before committing it, and say in the PR
why it changed. A port that needs a baseline updated has changed the UI.

**Fixture sessions** are built in code, not committed as JSONL.
`e2e/fixtures/standard.ts` is the shared fixture: add a session there as one
object (a stable id from `sessionId('name')`, a prompt, a time such as
`hoursAgo(2)`, and optionally `pinned`, `archived`, `slug`, `pullRequests`,
`name`, `cwd` for a worktree). Times are relative to a fixed `FIXTURE_NOW`, and
the renderer's clock is frozen there, so "2h ago" is stable. A test that needs
a different world passes its own spec with `test.use({ fixture: … })`.

**The helpers** are in `e2e/support/`: `fakeClaude(home, id)` and
`fakeSsh(home, id)` script the fake CLIs (titles, busy/idle, OSC 7501, OSC 9
notifications, output, transcript lines, a fork, an exit code),
`askQuestions` posts an AskUserQuestion to the session's hook,
`pushRemoteStatus` puts the connection card in any phase, and
`expectScreen` takes a whole-window screenshot. The host-facing channels
(usage, updates, sleep, the folder picker, the browser) answer from stubs a
test sets with `test.use({ stubs: … })` or `setHostStub`, and
`hostStubCalls` counts what the renderer asked for. A test about timing
passes `test.use({ fakeTimers: true })` and jumps the renderer's clock with
`page.clock.fastForward`.

**What belongs in e2e.** Prefer a unit test (`test/`, against a reducer, a
layout function or a service with fakes) whenever the behaviour can be decided
without the app. An e2e test is for what only the wired-up app can prove: an
IPC round-trip, the real terminal, keyboard and focus moving between surfaces,
a side effect in the main process, or a journey across several surfaces. Each
test launches the app, so a few fuller journeys beat many small checks. Find
elements by role, label or text, and add a `data-testid` only where nothing
accessible identifies the element.

## Writing tests

Every test, unit or e2e, is split into `/* Given */`, `/* When */` and
`/* Then */` blocks: setup, the one action under test, and the assertions.

```ts
test('archiving a session hides it from the recent list', () => {
  /* Given */
  const state = run(initialRendererState(), built([item(row('a'))]));

  /* When */
  const next = run(state, { type: 'sessionArchived', id: 'a' });

  /* Then */
  assert.deepEqual(visibleIds(next), []);
});
```

Leave out `/* Given */` when there is no setup. Test one behaviour per test. A
test that walks a sequence, such as an e2e journey, may repeat `/* When */` and
`/* Then */` pairs. Assertions never go in Given, and actions never go in Then.

## Building

All build commands build the app first, then invoke electron-builder.

```bash
npm run build:mac     # DMG + zip (arm64 + x64)
```

Output goes to `dist/`.

## Releasing

Releases are driven by git tags:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions workflow builds the macOS app and publishes to GitHub Releases. You can also release locally:

```bash
npm run release   # builds + publishes to GitHub Releases
```

Set `GH_TOKEN` in your environment (a GitHub personal access token with `repo` scope).

## Code Signing

For distribution, set these environment variables:

- `CSC_LINK` (p12 certificate) and `CSC_KEY_PASSWORD`, or sign via Keychain
- Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing (CI artifact builds)

The macOS build uses custom entitlements (`build/entitlements.mac.plist`) to allow JIT and unsigned memory execution, required by native modules (node-pty, better-sqlite3).

## Project Structure

Switchboard is arranged as a hexagon — rules in the middle, the world at the
edges, interfaces between them. See [ARCHITECTURE.md](ARCHITECTURE.md) for what
lives where and how to add to it.

```
src/domain/          The rules. Pure TypeScript: no node, no Electron, no DOM,
                     shared by both processes
src/application/     Use cases, written against port interfaces
src/application/ports/   The interfaces (repository, terminal, filesystem, …)
src/infrastructure/  The adapters: sqlite, node-pty, fs, ssh, electron
src/ipc/             The process boundary — channel names and the API contract
src/main/            Composition root + IPC handler registration + bootstrap
src/preload/         Context bridge; implements the IPC contract
src/renderer/        The UI: app/ (bootstrap, routing), state/, features/, lib/
src/renderer/styles/ SCSS partials, one per UI area
src/workers/         Worker threads (the cold-start project scanner)
app/                 Build output (gitignored) — what Electron actually runs
test/                Node test-runner suites, run through tsx
scripts/             Build (esbuild + sass), icon and postinstall scripts
build/               Icons, entitlements, builder resources
.github/workflows/   CI/CD
```

The app is written in TypeScript (strict) and SCSS. `npm run build` compiles
everything into `app/` with esbuild and sass; `npm run typecheck` runs `tsc`
over the whole tree; `npm test` builds and then runs the suites. Node 20 or
newer is required — TypeScript 7 will not load on 18.
