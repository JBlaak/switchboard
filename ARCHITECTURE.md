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
                      │     domain                 fs, ssh, mcp,
                      └───────────────────────     electron, claude-cli)
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
| `shell/` | shell families, argv quoting, WSL paths |
| `launch/` | the `claude` command line, session options, the child environment |
| `search/`, `settings/`, `schedule/`, `plans/`, `agent-files/`, `usage/` | the rules for each of those, similarly |

### `src/application` — the use cases

Orchestration written against interfaces.

- **`ports/`** — the interfaces. `SessionRepository`, `SearchIndex`,
  `SettingsStore`, `TerminalGateway`, `TranscriptStore`, `RendererGateway`,
  `FileSystem`, `IdeBridge`, `Clock`, `Timers`, `Logger`, and a few more.
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
transcript store, `ssh/`-shaped logic inside the supervisor, `mcp/` behind the
IDE bridge, `electron/` behind the window, the menu, the updater and the
renderer gateway, `claude-cli/` behind usage and statistics, `worker/` behind
the cold-start scanner.

### `src/main` — the composition root

`composition-root.ts` is the only file that constructs adapters, and
`ipc/` maps channels to use cases, one module per feature area. `index.ts` is
bootstrap: build, register, open a window, start the background work, shut down.

### `src/ipc` — the process boundary

`channels.ts` names every channel and `api.ts` states the whole contract. The
preload implements it and the renderer declares `window.api` against it, so
renaming a channel is a compile error rather than a runtime `undefined`.

### `src/renderer` — the driving adapter

- `app/` — bootstrap, the IPC listeners, the tab router, layout, the status bar
- `state/` — the session, activity and remote-status stores
- `features/` — one folder per feature: sessions, terminal, dialogs, plans,
  memory, stats, settings, panel, jsonl, remote
- `lib/` — DOM handles, formatting, icons, the editor setup

## How to add something

**A new thing the UI can ask for.** Add the channel to `src/ipc/channels.ts`
and the method to `src/ipc/api.ts`; forward it in `src/preload/index.ts`;
handle it in the matching `src/main/ipc/*-handlers.ts`.

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
