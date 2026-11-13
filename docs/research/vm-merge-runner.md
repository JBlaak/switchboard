# What the VM agent needs to run the Merge manager without the Mac

Research for #428 (map #420). Question: what is missing for the switchboard-agent (#276) to run a lane runner, watch queue lanes and start fix errands while the Mac is closed or offline?

Code references are to `origin/main` at d089ba21. Words like Lane runner, Queue lane and Fix errand are as defined in `GLOSSARY.md` (branch `docs/merge-manager-glossary`).

## Short answer

The agent already has most of the pieces a VM-side Merge manager would stand on: its own `gh` login and `claude` login, a cron loop that runs while the Mac is off, a persistent settings file, and `claude --worktree` sessions inside project copies. What it lacks is the Merge manager itself and four things around it:

1. **No lane runner process on the agent.** The agent only does what a Mac client asks, plus schedules. Nothing in `src/agent/parts.ts` polls GitHub or keeps lane state.
2. **The agent cannot start a session by itself.** `SessionHost.open` only runs for a client's `open` message, and answers that client. Schedules get around this by running headless `claude -p`, not PTY sessions.
3. **Turn ends are dropped when no Mac is connected.** Only `archive_session` survives the Mac being away (#308). A lane runner on the VM has to hear about turn ends and archives itself.
4. **No durable state except two JSON files.** Sessions, pending archives and anything a lane runner would hold live in memory, and an agent restart (crash, upgrade) ends every running session.

The deciding fact: the agent is built from the same `application` and `domain` layers as the Mac's main process (`src/agent/main.ts:1-13`, `src/agent/parts.ts:153-165`). A lane runner written as an application service with ports can be wired into the agent's composition root the way `hostScheduleService` is (`src/application/services/agent-host/host-schedules.ts:52-68`). So this is wiring and a few protocol messages, not a second implementation.

## 1. GitHub access on the VM

### What exists

The premise "the agent's gh calls are routed back through the Mac" is only half right.

- **The VM has its own `gh` login.** The setup terminal installs `gh` and runs `gh auth login` as the user, then `gh auth setup-git` so git pushes over HTTPS as that login (`src/domain/agent/setup-script.ts:39-41`, `:134-142`). It says so to the user: "This VM gets its own login; nothing is copied from your Mac" (`setup-script.ts:139`). The tools check reports `gh auth status` per host (`src/application/services/agent-host/host-config.ts:177-181`).
- **The VM already uses it.** A project hand-off clones with `gh repo clone` using the VM's login (`src/application/services/agent-host/copies.ts:5-7`, `:462`). Sessions on the VM run `gh` themselves, in the login-shell environment (`src/agent/parts.ts:4-9`, `:80-82`).
- **What is routed through the Mac is the pages' GitHub half.** The project page, session work page and Plan tab of a VM project read GitHub with the Mac's own `gh`; only git and transcripts go to the VM (`src/application/services/agent-host/tools.ts:5-8`). The `run-tool` message can run `gh` in a VM folder (`tools.ts:10`, `:258-277`; `AgentToolName = 'git' | 'gh'` at `src/domain/agent/protocol.ts:455`), but it is Mac-driven: a client asks, the agent runs it, the answer goes back to that client, and a client going away kills its runs (`tools.ts:198-207`). Every run gets `GH_PROMPT_DISABLED=1` and no stdin, so nothing hangs on a prompt (`tools.ts:132-140`).

So a lane runner on the VM can call `gh api` / `gh api graphql` in the agent's login-shell environment today, with no new credential plumbing. What it cannot do is reuse the Mac-side `run-tool` path; it would call a `ToolRunner` directly (`src/infrastructure/agent/node-tool-runner.ts`, argv only, process group killed on timeout).

### What the token needs

The Merge manager's calls (from #421 and the map):

| Call | Fine-grained permission | Classic scope |
| --- | --- | --- |
| Update branch, REST `PUT /pulls/{n}/update-branch` | Pull requests: write | `repo` |
| Update branch, GraphQL `updatePullRequestBranch` (REBASE, chosen in #421) | Pull requests: write (same as REST) | `repo` |
| Merge, `PUT /pulls/{n}/merge` | Contents: write | `repo` |
| Cancel a workflow run, `POST /actions/runs/{id}/cancel` | Actions: write | `repo` |
| Add or remove a label, `POST`/`DELETE /issues/{n}/labels` | Issues: write **or** Pull requests: write | `repo` |
| Read ruleset required checks, `GET /rules/branches/{branch}` | Metadata: read | `repo` |
| Read check runs, Checks API | **not supported** for fine-grained tokens (see below) | `repo` |
| Fix errand pushing a branch that touches `.github/workflows` | Workflows: write | `workflow` |

Sources: [Permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens); [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps). `update-branch` takes `expected_head_sha` (422 on mismatch) and `merge` takes `sha` (409 on mismatch), which is what lets a runner act only on the head it judged ([Pulls REST docs](https://docs.github.com/en/rest/pulls/pulls)).

Things that decide the token type:

- **`gh auth login` (what the setup terminal runs) gives an OAuth token with `repo`, `read:org`, `gist`** and no `workflow` ([`minimumScopes` in gh's auth flow](https://github.com/cli/cli/blob/trunk/internal/authflow/flow.go)). That covers every row above except workflow files. The `workflow` scope is not needed when "an identical file, with the same path and contents, exists on another branch in the same repository" ([OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)): a rebase that only brings in the trunk's workflow files is fine, a fix errand that edits a workflow file is not. `gh auth refresh -s workflow` adds it.
- **Fine-grained tokens are limited to one resource owner** (a user or one organization), may need approval from organization owners before they reach private resources, and do not support the Checks API ([Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)). A Merge manager covering personal repos and an organization's queue repo would need one fine-grained token per owner, and its green check would have to go through something other than the Checks API (GraphQL `statusCheckRollup` is the candidate; not verified with a fine-grained token here). gh itself warns against passing a fine-grained token to `--with-token` and recommends `GH_TOKEN` for them ([gh auth login](https://cli.github.com/manual/gh_auth_login)).
- **Conclusion: keep the user's own `gh auth login` on the VM** (what setup already does), with `workflow` added if fix errands may touch workflows. A fine-grained token is not a drop-in for it.

### Storage on a headless box

`gh auth login` stores the token in the OS credential store, and "will fallback to writing the token to a plain text file" when none is available ([gh auth login](https://cli.github.com/manual/gh_auth_login)). A headless Linux VM normally has no running secret service, so in practice the token sits in `~/.config/gh/hosts.yml` under the VM user's home. `gh auth status` shows which. The agent itself stores nothing: it inherits whatever the login shell's `gh` finds (`src/agent/parts.ts:80-82`).

### Security meaning

- The VM holds a long-lived token that can push to, merge and relabel every repository the user can. Anyone who gets the VM user's shell (or a session's `claude`, which runs with that environment and the host instructions "install whatever you need") can use it. This is already true today: setup puts it there for sessions (#276 user story 9).
- What the Merge manager adds is **unattended use**: merges and force-pushed rebases happen with nobody watching. The guards that keep that safe are GitHub-side (required approval, rulesets, `expected_head_sha`/`sha` pins) and the map's rule that Switchboard never approves.
- #276 user story 11 ("my Mac's credentials never copied to the VM") holds: nothing new crosses from the Mac.

## 2. Starting a Claude session with nobody at the Mac

### Claude auth

Enough already. Setup signs `claude` in on the VM once (`~/.claude/.credentials.json`, or `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`; `setup-script.ts:144-153`), and the tools check reads it (`host-config.ts:188`, `:196-203`). Schedules already run headless `claude` with it while the Mac is off (`src/infrastructure/agent/node-schedule-runner.ts:1-22`).

### Can the agent start a session itself

**Not as a PTY session.** `SessionHost` opens a session only for a client's `open` message and sends `opened` back to that client (`src/application/services/agent-host/session-host.ts:111-115`, `:153-216`). Session ids come from the Mac. There is no internal "open" an agent-side service can call.

What does exist:

- **Headless runs.** The schedule service starts `claude -p`-style runs detached, with the host instructions appended, from the agent's own cron loop (`node-schedule-runner.ts:44-70`; `src/application/services/schedule-service.ts:33`, `:180`). A fix errand could run the same way, but it would have no terminal for the user to attach to later and no question hook.
- **The Mac learns of runs it did not start.** `list-transcripts` returns the sessions whose transcripts sit in given folders since a time (`src/domain/agent/protocol.ts:533-547`). `VmSchedulesService` polls it on connect and records unknown sessions as rows (`src/application/services/vm-schedules-service.ts:310-335`). A fix errand started on the VM would show up on the Mac the same way once it reconnects.

**Missing:** a `SessionHost.start` that an agent-side service can call with no client (it already keeps running with no client, `session-host.ts:9-12`), plus a way to tell the Mac "these sessions were started while you were away", like `list-self-archived` does for archives. With that, a fix errand is a real PTY session the user can attach to from the Mac or phone later.

### Hooks when the Mac link is down

The agent runs its own question hook server on the VM's `127.0.0.1`; `HookForwarder` turns what the CLI posts into messages to the Mac (`src/application/services/agent-host/hook-forwarder.ts:1-11`; wired in `src/agent/parts.ts:84-110`). With no Mac:

- **Asks** are released with no decision, so the CLI asks in its own terminal (`hook-forwarder.ts:13-17`, `:81`). A fix errand that asks a question waits in a terminal nobody sees until the Mac comes back.
- **`archive_session`** is accepted on the VM (#308). When the turn ends and still no Mac is connected, the agent stops the session and records it in `~/.switchboard/self-archived.json`, which outlives a restart; the Mac reads and clears it on its next connect (`hook-forwarder.ts:35-50`; `src/domain/agent/layout.ts:39-44`).
- **Turn ends, prompt submits, subagent starts/stops and grill turns are dropped** (`hook-forwarder.ts:362-367`).

So a fix errand's "push and archive myself" already works with the Mac away. What a VM lane runner would miss is the turn-end and exit notices it needs to react to an errand finishing (or stalling). **Missing:** a local subscriber on the forwarder (an in-process listener beside the client send), and the session's exit, which `SessionHost` already sees.

## 3. Long-running work on the agent

### Schedules

The agent builds a `ScheduleService` scoped to the folders in `HostSettings.scheduleDirs` and starts its 60-second cron loop once it is listening (`src/agent/main.ts:70-71`; `host-schedules.ts:1-19`; `schedule-service.ts:33`, `:180-212`). Folders are read again on every tick, so a change from the Mac counts within a minute. This is the only thing on the agent today that acts without a client, and the model a lane runner would follow: a service built in `createParts`, started by `main`, stopped on SIGTERM.

### Persistence

What survives an agent restart:

- `~/.switchboard/host-settings.json`: host instructions, config-copy switch, base folder, schedule folders (`layout.ts:36-37`; `protocol.ts:77-83`).
- `~/.switchboard/self-archived.json` (`layout.ts:39-44`).
- Project copies on disk, each marked with `COPY_MARKER` in its `.git` (`copies.ts:12-20`), and the VM's own `~/.claude/projects` transcripts.

What does not: sessions, their scrollback (max 50 ended sessions kept, `session-host.ts:43-50`), pending archives (`hook-forwarder.ts:49-50`), held asks. The agent has no SQLite index (`host-schedules.ts:13-16`).

**Missing:** a lane state file (landed PRs per repo, held/head, which fix errand belongs to which PR), written atomically like the others (`src/infrastructure/agent/atomic-write.ts`). Most lane state can be re-derived from GitHub on start (labels, open PRs), so the file only has to hold what GitHub does not: which PRs were landed in a Switchboard lane, and errand ownership.

### Upgrades

- The agent is upgraded only from the Mac, over ssh: unpack a new version beside the old, switch the `current` link, `systemctl --user stop` then `start` (`layout.ts:17-23`; `src/domain/agent/install-script.ts:390-421`).
- The systemd unit uses the default KillMode, so **stopping the agent ends every session** (`install-script.ts:323-331`). Schedule runs are detached into their own process group but "systemd's stop of the whole unit still ends it" (`node-schedule-runner.ts:16-19`).
- Because of that, the Mac upgrades an agent of the same protocol only while it has no live session; otherwise the user chooses Update agent (`src/application/services/agent-upgrades.ts:1-15`, `:49-68`). A protocol mismatch upgrades at once, whatever runs (`agent-upgrades.ts:44-47`).
- `Restart=on-failure` brings a crashed agent back (`install-script.ts:340-343`), with all sessions gone.

For a Merge manager this means: an app update does not disturb a VM lane runner while errands run (good), but an agent crash or a forced protocol upgrade kills running fix errands. The lane runner must treat "my errand's session is gone" as a normal case on start: re-read GitHub, and start a new errand if the PR is still stuck. A lane runner holding no session of its own does not block upgrades; whether "landed PRs waiting" should count as "live" for `agent-upgrades.ts` is a design choice.

## 4. Worktrees on the VM

### What exists

- **Project copies.** A project hand-off clones the repo into `<baseFolder>/<repo.name>` with the VM's credentials, then lays the Mac's unpushed commits, uncommitted changes and chosen ignored files on top (`protocol.ts:315-330`; `copies.ts:1-20`, `:454-463`).
- **Worktree hand-off.** A session hand-off can land in `<copy>/.claude/worktrees/<name>` on a given branch, one repository serving the main folder and every worktree (`copies.ts:146-149`, `:345-352`, `:489-500`).
- **`claude --worktree`** on a VM session creates its worktree inside the copy, and is dropped for a folder that is not a git repository (`session-host.ts:225-235`).
- All of this is started by a Mac `handoff` message; nothing on the agent decides to make a copy.

### A fix errand for a PR branch

- **The VM has a copy of the repo:** a fix errand can be a `claude --worktree` session in that copy whose first step is `gh pr checkout <n>` (or `git fetch origin pull/<n>/head` and a branch), push with the VM's login, then `archive_session`. The `--worktree` part keeps the copy's main folder untouched. Agent-side the only new piece is the self-started session from section 2. The copy's `COPY_MARKER` rules (`copies.ts:12-20`) are about hand-offs and do not stop a session's own worktree.
- **The VM has no copy:** the agent can clone one itself with the same code a hand-off uses (`cloneOrFetch`, `copies.ts:434-463`), minus the bundle and patch, since a PR branch is already on origin. Today that path is reachable only through a `handoff` message from a client. **Missing:** an agent-side "ensure a copy of this GitHub repo" call, and a rule for where it goes (`baseFolder`) and whether the Mac then shows it as a VM project.
- Fork PRs: `gh pr checkout` handles them, but pushing back needs "allow edits by maintainers". Same limit as on the Mac.

## What is missing, in order of size

1. **A lane runner service wired into the agent** (`createParts` + `main`), with a GitHub port backed by the VM's `gh`, and a hand-off that moves lane ownership from the Mac to the agent and back (like schedules' `scheduleDirs`, so each lane runs in exactly one place).
2. **Self-started sessions:** an agent-side way to open a PTY session with no client, and a protocol message so the Mac learns of them on connect.
3. **Local hook subscribers:** turn ends and session exits delivered to agent-side services, not only to a connected Mac.
4. **A lane state file** that survives restarts, and a lane runner that recovers when its errands died with an agent restart.
5. **An agent-side "ensure copy"** for repos the VM has no copy of.
6. **Token:** add `workflow` to the VM's `gh` login if fix errands may edit workflow files. No new storage.

The biggest gap is 1 and 2 together: the agent today is a server that waits for the Mac, plus one cron loop. Everything the Merge manager does on its own (poll lanes, start errands, notice they ended) needs the agent to act as its own client.

## Open questions

- Does GraphQL `statusCheckRollup` read check runs with a fine-grained token, given the Checks API is unsupported for them? Matters only if a fine-grained token is ever chosen.
- Should landed PRs waiting in a VM lane block the automatic agent upgrade the way live sessions do?
- A fix errand that asks a question while the Mac is away waits in its own terminal. Is that "Needs you", and how does the user see it from the phone (VM sessions reach the phone only through the Mac)?
