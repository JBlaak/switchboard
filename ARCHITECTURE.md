# Architecture

Switchboard is an Electron app arranged as a hexagon: the rules in the middle,
the world at the edges, and interfaces between them. The point is that the
interesting logic — when a dropped SSH link is worth redialling, which of a
session's four possible names wins, whether a row invented for a session that
never started should still be on screen — can be read and tested without
booting Electron, opening a database or spawning a process.

```
                    ┌─────────────────────────────────┐
   renderer  ──IPC──▶            main                 │
   (a driving         │  composition-root.ts          │
    adapter)          │        ▼                      │
                      │  application ── ports ──▶ infrastructure
                      │        ▼                  (sqlite, node-pty,
                      │     domain                 fs, ssh, electron,
                      └───────────────────────     claude-cli)
```

Dependencies point inward only. `domain` imports nothing. `application` imports
`domain` and its own port interfaces. `infrastructure` implements those ports.
`main` is the only place that knows both an interface and the thing behind it.

## The layers

### `src/domain` — the rules

Pure TypeScript: no `node:` imports, no Electron, no DOM. Shared by both
processes, which is why the renderer can use the same session, tier and
remote-status rules the main process does instead of a parallel copy.

| | |
|---|---|
| `session/` | what a session is, how its transcript parses, which of its names wins, how rows are ranked and truncated, when a pending row is abandoned, how a fork is recognised |
| `session-work/` | a session's footprint for the Session work page: its work items, the unified-diff parser and which files start collapsed, the Ship it steps, the auto-fix limit, the PR status dot, which actions an item offers, and the prompts every action types |
| `plan/` | an epic and its sub-issues for the Plan tab: levels from "Blocked by" links, row order, each issue's state, the current level and the warnings, the body summary, and the branch and prompt that start a session on an issue |
| `project/` | project-path encoding and shortening, `ssh://` identity, assembling the project list |
| `remote/` | the SSH reconnect policy, the ssh command, connection status |
| `terminal/` | OSC parsing (busy/idle/notifications), the output ring buffer, the banners Switchboard writes itself |
| `shell/` | shell profiles and argv quoting |
| `launch/` | the `claude` command line, session options, the child environment |
| `power/` | reading `pmset`'s SleepDisabled flag for the toolbar's sleep switch |
| `weather/` | folding a WMO weather code into the four skies the empty-state mascot dresses for, and parsing the forecast and geocoding responses |
| `update/` | whether a published release is newer than the running app, and which zip this Mac's architecture installs from |
| `search/`, `settings/`, `schedule/`, `usage/` | the rules for each of those, similarly |

### `src/application` — the use cases

Orchestration written against interfaces.

- **`ports/`** — the interfaces. `SessionRepository`, `SearchIndex`,
  `SettingsStore`, `TerminalGateway`, `TranscriptStore`, `RendererGateway`,
  `FileSystem`, `ShellProfiles`, `Clock`, `Timers`, `Logger`, and a few more.
- **`model/`** — `ActiveSession` (a running session: a PTY, a buffer, a
  connection) and `SessionRegistry`, which can find a session by any id it has
  answered to.
- **`services/`** — the work. `SessionLauncher` opens a session,
  `SessionLifecycle` wires and ends one, `RemoteConnectionSupervisor` keeps a
  remote one connected, `SessionIndex` keeps the cache honest,
  `SessionTransitionDetector` notices a fork, plus one service per feature area.

Nothing here reads `Date.now()`, calls `setTimeout`, or touches a file directly.

### `src/infrastructure` — the adapters

One implementation per port: `sqlite/` behind the repository, the index, the Session work queue and the auto-fix history,
`pty/` behind the terminal gateway and the session prompter, `fs/` behind the filesystem and the
transcript store, `ssh/`-shaped logic inside the supervisor, `shell/` behind
the shell profiles, `electron/` behind the window, the menu and the renderer
gateway, `claude-cli/` behind usage and scheduled runs, `worker/` behind
the cold-start scanner, `weather/` (Open-Meteo) behind the weather source, `system/` (`pmset`) behind
the sleep switch and (a bundle swap) behind the app installer, `github/` behind the release feed
and (the user's own `gh`) behind the Session work page's PRs and issues, `git/` (the `git` CLI)
behind the remotes and the session's worktrees.

### `src/main` — the composition root

`composition-root.ts` is the only file that constructs adapters, and
`ipc/` maps channels to use cases, one module per feature area. `index.ts` is
bootstrap: build, register, open a window, start the background work, shut down.

### `src/ipc` — the process boundary

`channels.ts` names every channel and `api.ts` states the whole contract. The
preload implements it and the renderer declares `window.api` against it, so
renaming a channel is a compile error rather than a runtime `undefined`.

### `src/renderer` — the driving adapter

- `app/` — bootstrap, the IPC bridge and its follow-ups, the shortcuts,
  layout, the re-key of the registries outside the store
- `state/` — the store, the event union, the reducers (one slice per
  concern), and the `*-store` adapters the modules outside React read through
- `ui/` — the React root, the `Portal` surfaces render through, and one
  folder per surface: components, an `actions.ts` behind them, and an
  `install-*.ts` for its timers
- `features/` — the imperative modules: the xterm lifecycle and its write
  buffer, session launch and fetch, the poller, the list's keyboard, motion
  specs
- `lib/` — the containers the imperative code drives, formatting, icons,
  motion

Every surface is React, and state flows one way:

```
IPC push (app/ipc-bridge) ─┐
user action (ui/*/actions) ┼─▶ dispatch(RendererEvent) ─▶ reducers ─▶ store
timer (ui/*/install-*) ────┘     (state/events)         (state/*-slice)  │
                                                                         ▼
                 useStore(selector) in a component, or an onEvent subscriber
terminal data ─────────▶ write buffer ─▶ xterm (never through the store)
```

Every change is a typed `RendererEvent`; the reducers are pure and tested in
node like the domain code. Components read with `useStore(selector)`, which
re-renders only when the selection changes, and call the functions in their
surface's `actions.ts`, which call `window.api` and dispatch the answer. What
has to follow an event outside React — re-keying the registries, the exit
banner, a debounced re-fetch — subscribes to the store with `onEvent`
(`app/ipc-listeners`, installed first so a re-key has moved everything before
anyone else looks).

The React root renders nothing itself: each surface portals into its
container in `index.html`, which keeps the page's layout as static markup.
Registries that hold live objects — `openSessions` with its xterm instances,
and the shared session rows that every cached project list points at — stay
plain Maps outside the store. That is also why the session list is laid out on
request rather than derived: whoever changed the rows calls
`relayoutSessionList` (`ui/session-list/relayout`), and the slice lays the
list out against its previous order so it holds still between layouts.

What stays imperative, each driven from React effects with refs or from the
modules in `features/`:

- **The terminals.** `ui/terminal/TerminalHost` renders a container per open
  session; `features/terminal/terminal-manager` opens an xterm into it and
  owns everything inside: keys, fit, focus, drag-and-drop. Its output goes
  through `features/terminal/write-buffer`, which batches the byte stream
  into frames and holds back synchronised-update blocks.
- **The main area's panel swap.** The empty screen, the terminal area, the
  settings panel and the Session work page are shown and hidden by style
  (`lib/dom`), because a terminal can only take focus or be refitted once its
  panel has a layout box, synchronously. The Session work page follows its
  slice (`ui/session-work/install-session-work`): it closes whenever another
  session, the empty screen or the settings panel takes the main area.
- **Motion.** The springs, the list's reflow and the confetti
  (`lib/motion/*`), and the question panel's motion spec, play on the DOM
  React committed, measured before and after.
- **Patch**, the empty screen's friend, is its package's own imperative
  handle, mounted into the stage `ui/patch/EmptyScreenPatch` renders.
- **The list's keyboard focus.** `#sidebar-content` holds the focus while the
  cursor is out (`features/sessions/sidebar-keyboard`); the cursor itself is
  state.

A session's id can change under it (a fork, an accepted plan). The reducer
moves every slice keyed by session id in one pass (`rekeyState` in
`state/root`), and `app/rekey-registries` moves the Maps outside the store, in
a stated order. Rendering keys a row by the session's stable local key
(`state/keys-slice`), not its id, so a re-keyed row keeps its element.

## How to add something

**A new thing the UI can ask for.** Add the channel to `src/ipc/channels.ts`
and the method to `src/ipc/api.ts`; forward it in `src/preload/index.ts`;
handle it in the matching `src/main/ipc/*-handlers.ts`. A push from main also
needs its event in `src/renderer/state/events.ts` (the typecheck insists) and
a line in `src/renderer/app/ipc-bridge.ts`.

**A new rule.** Put it in `src/domain` and unit-test it directly — no fakes
needed, because there is nothing to fake.

**A new external system.** Write the interface in
`src/application/ports/`, use it from a service, implement it in
`src/infrastructure/`, and wire it in `composition-root.ts`.

**A new UI surface.** A folder under `src/renderer/ui/`, the way `footer/` is
laid out: components in `.tsx` files, rendered from `Root.tsx` through a
`<Portal>` into the surface's container in `index.html`; an `actions.ts` that
calls `window.api` and dispatches the answer, which is all the components
call; and, if the surface has timers or launch-time fetches, an
`install-*.ts` that starts them from `bootstrap.ts` and dispatches events, so
they stay out of React's (StrictMode-doubled) effects. Its state is a slice
in `state/`, tested in node.

## Testing

`npm test` runs `tsx --test test/*.test.ts`. Most tests import a domain module
and call it. The ones that need a port use the doubles in `test/support/fakes.ts`
— a fake clock, a fake PTY, a recording renderer gateway — which is what lets
the kill-escalation ladder and the reconnect backoff be tested without waiting
on real time.

`test/db-schema-reconcile.test.ts` is the exception: better-sqlite3 is compiled
for Electron's ABI, so it runs the built `app/database.js` under
Electron-as-Node. That is why `scripts/build.mjs` emits it separately.

Node 20 or newer is required to run the toolchain (TypeScript 7).
