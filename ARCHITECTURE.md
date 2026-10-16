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

One implementation per port: `sqlite/` behind the repository and the index,
`pty/` behind the terminal gateway, `fs/` behind the filesystem and the
transcript store, `ssh/`-shaped logic inside the supervisor, `shell/` behind
the shell profiles, `electron/` behind the window, the menu and the renderer
gateway, `claude-cli/` behind usage and scheduled runs, `worker/` behind
the cold-start scanner, `weather/` (Open-Meteo) behind the weather source, `system/` (`pmset`) behind
the sleep switch and (a bundle swap) behind the app installer, `github/` behind the release feed.

### `src/main` — the composition root

`composition-root.ts` is the only file that constructs adapters, and
`ipc/` maps channels to use cases, one module per feature area. `index.ts` is
bootstrap: build, register, open a window, start the background work, shut down.

### `src/ipc` — the process boundary

`channels.ts` names every channel and `api.ts` states the whole contract. The
preload implements it and the renderer declares `window.api` against it, so
renaming a channel is a compile error rather than a runtime `undefined`.

### `src/renderer` — the driving adapter

- `app/` — bootstrap, the IPC bridge and its follow-ups, the tab router, layout,
  the sidebar footer
- `state/` — the store, the event union, the reducers, and the `*-store`
  adapters the vanilla code still reads through
- `ui/` — the React root and the `Portal` surfaces render through
- `features/` — one folder per feature: sessions, terminal, dialogs,
  settings, panel, remote
- `lib/` — DOM handles, formatting, icons, motion

The renderer is moving to React one surface at a time, and state flows one
way:

```
IPC push (app/ipc-bridge) ─┐
user action ───────────────┼─▶ dispatch(RendererEvent) ─▶ reducers ─▶ store
timer ─────────────────────┘     (state/events)         (state/*-slice)  │
                                                                         ▼
                        useStore(selector) in a component, or a vanilla subscriber
terminal data ─────────▶ terminal manager (never through the store)
```

Every change is a typed `RendererEvent`; the reducers are pure and tested in
node like the domain code. React components read with `useStore(selector)`,
which re-renders only when the selection changes. The vanilla code that has
not moved yet keeps its old calls through the `*-store` adapters, and what
must still touch the DOM after an event subscribes to the store
(`app/ipc-listeners`, `features/sessions/sidebar-activity`). The React root
renders nothing itself: each ported surface portals into the container it
already has in `index.html`. Registries that hold live objects — `openSessions`
with its xterm instances, and the shared session rows — stay plain Maps
outside the store.

A session's id can change under it (a fork, an accepted plan). The reducer
moves every slice keyed by session id in one pass (`rekeyState` in
`state/root`), and `app/rekey-registries` moves the Maps outside the store, in
a stated order. Rendering keys a row by the session's stable local key
(`state/keys-slice`), not its id, so a re-keyed row is morphed in place.

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

**A new UI surface.** A folder under `src/renderer/features/`, installed from
`src/renderer/app/bootstrap.ts`.

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
