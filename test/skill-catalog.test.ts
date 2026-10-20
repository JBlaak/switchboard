import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeSkillCatalog } from '../src/infrastructure/claude-cli/skill-catalog';
import { NodeFileSystem } from '../src/infrastructure/fs/node-file-system';
import { silentLog } from './support/fakes';

/**
 * The skills Quick Ask reads from Claude Code's own files (#142): the user's,
 * the enabled plugins', and each project's own. Nothing here reads the real
 * `~/.claude`.
 */

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-skills-test-'));
  const claudeDir = path.join(root, '.claude');
  const app = path.join(root, 'code', 'app');
  const site = path.join(root, 'code', 'site');
  /** Write `content` at `file`, making its folders. */
  const put = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const skill = (dir: string, front = '') => put(path.join(dir, 'SKILL.md'), `---\n${front}description: x\n---\n`);
  const plugin = (name: string, manifest: Record<string, unknown> = {}) => {
    const installPath = path.join(claudeDir, 'plugins', 'cache', name);
    put(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, ...manifest }));
    return installPath;
  };
  const catalog = new ClaudeSkillCatalog({ fs: new NodeFileSystem(), claudeDir, log: silentLog });
  return { root, claudeDir, app, site, put, skill, plugin, catalog, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('skill catalog: the user\'s skills and commands, and the enabled plugins\' by their own names', (t) => {
  /* Given */
  const h = harness();
  t.after(h.cleanup);
  h.skill(path.join(h.claudeDir, 'skills', 'task'));
  h.skill(path.join(h.claudeDir, 'skills', 'helper'), 'user-invocable: false\n');
  h.skill(path.join(h.claudeDir, 'skills', 'synced', 'account-1', 'pdf'));
  h.put(path.join(h.claudeDir, 'commands', 'release.md'), 'Release it.');
  h.put(path.join(h.claudeDir, 'commands', 'git', 'tidy.md'), 'Tidy up.');
  const matt = h.plugin('mattpocock-skills', { skills: ['./skills/productivity/grill-me'] });
  h.skill(path.join(matt, 'skills', 'productivity', 'grill-me'), 'name: grill-me\ndisable-model-invocation: true\n');
  const off = h.plugin('switched-off');
  h.skill(path.join(off, 'skills', 'nope'));
  h.put(path.join(h.claudeDir, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'mattpocock-skills@official': true, 'switched-off@official': false },
  }));
  h.put(path.join(h.claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'mattpocock-skills@official': [{ scope: 'user', installPath: matt }],
      'switched-off@official': [{ scope: 'user', installPath: off }],
    },
  }));

  /* When */
  const skills = h.catalog.list([h.app]);

  /* Then */
  assert.deepEqual(skills, { everywhere: ['git:tidy', 'grill-me', 'release', 'task'], byProject: {} });
});

test('skill catalog: a project adds its own skills, commands and plugins', (t) => {
  /* Given */
  const h = harness();
  t.after(h.cleanup);
  h.skill(path.join(h.app, '.claude', 'skills', 'deploy'));
  h.put(path.join(h.app, '.claude', 'commands', 'schedule-nightly.md'), 'Every night.');
  const tools = h.plugin('movelab-claude-skills');
  h.skill(path.join(tools, 'skills', 'kotlin-style'));
  h.put(path.join(tools, 'commands', 'create-pr.md'), 'Open a PR.');
  h.put(path.join(h.claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'movelab-claude-skills@movelab': [{ scope: 'project', projectPath: h.app, installPath: tools }] },
  }));

  /* When */
  const skills = h.catalog.list([h.app, h.site]);

  /* Then */
  assert.deepEqual(skills, {
    everywhere: [],
    byProject: { [h.app]: ['create-pr', 'deploy', 'kotlin-style', 'schedule-nightly'] },
  });
});

test('skill catalog: nothing set up, or files it can\'t read, is no skills', (t) => {
  /* Given */
  const h = harness();
  t.after(h.cleanup);
  h.put(path.join(h.claudeDir, 'settings.json'), '{ not json');
  h.put(path.join(h.claudeDir, 'plugins', 'installed_plugins.json'), '[]');

  /* When */
  const skills = h.catalog.list([h.app]);

  /* Then */
  assert.deepEqual(skills, { everywhere: [], byProject: {} });
});
