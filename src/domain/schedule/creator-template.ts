/**
 * The prompt the schedule creator runs on.
 *
 * Schedules are usually made in Switchboard's Schedule manager, where Claude
 * drafts one from a sentence and the user reviews it as a form. This slash
 * command is the other way in: any Claude session can be asked to write a
 * schedule file, which then shows in the Schedule manager as New, off until
 * the user turns it on there.
 *
 * It is prose rather than code, which is why it lives in a file of its own; the
 * service that installs it is next door.
 */

/** Installed as `~/.claude/commands/create-switchboard-schedule.md`. */
export const SCHEDULE_CREATOR_TEMPLATE = `---
name: create-switchboard-schedule
description: Create a new Switchboard scheduled task for this project
---

You are helping the user create a scheduled task in Switchboard. The task runs on its own on a cron schedule, with Claude Code in headless mode (\`-p\`), on the user's own Claude subscription: nobody is there to answer a question while it runs.

## Instructions for the user

I'll help you set up a scheduled task for this project. Tell me:
- **What** the task should do
- **When** it should run (e.g. "every night", "every weekday at 9am", "hourly", "every Sunday night")

I'll write the schedule file. It shows up in Switchboard's Schedule manager as New, and stays off until you turn it on there. You can change everything about it there too.

## How to create the task

Ask the user what the task should do and when it should run. Keep it conversational: one or two questions at a time, not all at once.

Once you have enough, turn their description into a cron expression and confirm it in plain English (e.g. "That's every weekday at 9:00"). Most schedules run at night, while the Mac is otherwise idle.

## File format

Save to \`<project-root>/.claude/commands/schedule-<slug>.md\`:

\`\`\`markdown
---
name: <Human readable name>
cron: <5-field cron expression, local time>
enabled: false
slug: <short-kebab-case-id>
missed: run-once
limit-minutes: 30
week-cap: 80
worktree: true
cli:
  permission-mode: acceptEdits
  allowed-tools: <select based on task needs>
  # only include this if the user asked for a model:
  # model: <sonnet | opus | haiku>
---

<The full prompt that will be sent to Claude when this task runs>
\`\`\`

Always write \`enabled: false\`: the user turns a new schedule on in the Schedule manager, after looking it over.

| Key | Means |
|-----|-------|
| \`missed\` | What happens when the Mac slept through the time: \`run-once\` runs it once when the Mac wakes, \`skip\` waits for the next time |
| \`limit-minutes\` | Stop the run after this many minutes; leave the key out for no limit |
| \`week-cap\` | Don't start when more than this percent of the user's weekly Claude usage is used; leave it out for no cap |
| \`worktree\` | \`true\` works in a fresh git worktree off the default branch, so the user's checkout is never touched; \`false\` works in the project folder itself |

Pick \`worktree: true\` for anything that changes files or makes commits, and keep the limits unless the user asks otherwise.

## Selecting permissions

Scheduled tasks run headless, so choose the minimum tools needed for the task. Available tools:

| Tool | Use when the task needs to... |
|------|-------------------------------|
| Bash | Run shell commands, scripts, tests, git operations |
| Read | Read files from the project |
| Write | Create new files |
| Edit | Modify existing files |
| Glob | Find files by name pattern |
| Grep | Search file contents |
| WebFetch | Fetch URLs, APIs, web pages |
| WebSearch | Search the web |

Narrower rules and MCP tools go in the same comma-separated list, e.g. \`Bash(gh pr:*)\` or \`mcp__bugsnag__list_errors\`.

Examples:
- **Web scraping task** → \`Bash,Read,Write,Glob,WebFetch\`
- **Test runner** → \`Bash,Read,Glob,Grep\`
- **Code refactor** → \`Bash,Read,Write,Edit,Glob,Grep\`
- **Report generator** → \`Bash,Read,Write,Glob,Grep,WebFetch\`

Default permission-mode is \`acceptEdits\`. Always include at least \`Read\` and \`Glob\`.

## Writing the prompt

The prompt runs unattended, with no conversation history and no one to ask. Write it so it stands on its own:
- Say everything it needs: which project, which service, what counts as worth doing.
- Say what to skip, and when to stop (e.g. "at most 3 PRs"; "if nothing needs doing, say so and stop").
- Never ask the user a question in it; decide, or leave the thing alone and say so.
- End with a short report: one line per thing it did or skipped. Switchboard shows that report as the run's result.

## Rules

- The slug must be kebab-case, short, and descriptive
- If the \`.claude/commands/\` directory doesn't exist, create it
- After saving, tell the user: "Your schedule is saved. It's in Switchboard's Schedule manager as New, and stays off until you turn it on there."
- If the user wants to see existing schedules, list any \`schedule-*.md\` files in \`.claude/commands/\`
`;
