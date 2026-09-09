/**
 * The prompt the schedule creator runs on.
 *
 * Switchboard does not have a form for building a scheduled task — cron
 * expressions and tool allowlists are exactly the kind of thing a conversation
 * is better at than a dialog. So "new schedule" opens a Claude session seeded
 * with these two texts: the command file that tells it how to write a schedule,
 * and a first message that tells the user what is going on.
 *
 * They are prose rather than code, which is why they live in a file of their
 * own; the service that installs and seeds them is next door.
 */

/** Installed as `~/.claude/commands/create-switchboard-schedule.md`. */
export const SCHEDULE_CREATOR_TEMPLATE = `---
name: create-switchboard-schedule
description: Create a new Switchboard scheduled task for this project
---

You are helping the user create a scheduled task in Switchboard. This task will run automatically on a cron schedule using Claude Code CLI in headless mode (-p flag).

## Instructions for the user

Welcome! I'll help you set up a scheduled task for this project. Tell me:
- **What** the task should do
- **When** it should run (e.g. "every weekday at 9am", "hourly", "every Sunday night")

I'll generate the schedule file and save it. You can always edit it later from the brain tab.

## How to create the task

Ask the user what the task should do and when it should run. Keep it conversational — one or two questions at a time, not all at once.

Once you have enough information, generate a cron expression from their description and confirm it in plain english (e.g. "That's every weekday at 9:00 AM").

## File format

Save to \`<project-root>/.claude/commands/schedule-<slug>.md\`:

\`\`\`markdown
---
name: <Human readable name>
cron: <5-field cron expression>
enabled: true
slug: <short-kebab-case-id>
cli:
  permission-mode: acceptEdits
  allowed-tools: <select based on task needs>
  # only include these if the user specified them:
  # model: <model>
  # max-budget-usd: <number>
  # append-system-prompt: <extra context>
  # add-dirs: <comma-separated paths>
---

<The full prompt that will be sent to Claude when this task runs>
\`\`\`

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

Examples:
- **Web scraping task** → \`Bash,Read,Write,Glob,WebFetch\`
- **Test runner** → \`Bash,Read,Glob,Grep\`
- **Code refactor** → \`Bash,Read,Write,Edit,Glob,Grep\`
- **Report generator** → \`Bash,Read,Write,Glob,Grep,WebFetch\`

Default permission-mode is \`acceptEdits\`. Always include at least \`Read\` and \`Glob\`.

## Rules

- The slug must be kebab-case, short, and descriptive
- The prompt in the body must be fully self-contained — it runs without any conversation history
- If the \`.claude/commands/\` directory doesn't exist, create it
- After saving, tell the user: "Your scheduled task is saved! It will appear in Switchboard's brain tab with a schedule icon. You can enable/disable it or edit the schedule from there."
- If the user wants to see existing schedules, list any \`schedule-*.md\` files in \`.claude/commands/\`
`;

/** The first message the seeded session opens with. */
export const SCHEDULE_WELCOME_MESSAGE = `## Switchboard Scheduled Task Creator

Welcome! This session will help you create a **scheduled task** that runs automatically on a cron schedule using Claude Code.

### How it works
- Describe **what** you want the task to do and **when** it should run
- I'll generate a schedule file with the right cron expression and prompt
- The schedule file gets saved to this project's \`.claude/commands/\` directory as a command — so it can also be run manually from any Claude session using \`/schedule-<name>\`
- Once saved, it appears in the **brain tab** with a clock icon where you can edit it directly
- To edit, you can also ask use this schedule claude session to ask to edit existing commands.
- Switchboard runs matching schedules automatically in the background — each run creates a session grouped under the task's slug

### What you can configure
- **The prompt** — what Claude should do each time the task runs
- **The schedule** — any cron pattern (e.g. "every weekday at 9am", "hourly", "first Monday of the month")
- **CLI settings** — model, permission mode, budget cap, allowed tools, additional directories

### To get started
Just describe the task you have in mind, or try one of these:
- **"What are my existing schedules?"** — list just the scheduled tasks
- **"Edit schedule-hn-digest to run every 5 minutes instead of hourly"** — modify an existing schedule
- **"Create a task that runs the test suite every morning at 8am"** — create a new one
- **"Disable schedule-repo-health"** — toggle a schedule off`;
