import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readSkillFrontmatter, routeSkills, skillCommands } from '../src/domain/ask/skills';

/**
 * The skills Quick Ask names to the routing call (#142), by the command each
 * one is typed as.
 */

test('a skill is typed by its own name', () => {
  /* Given */
  const entries = [{ name: 'grill-me', plugin: 'mattpocock-skills' }, { name: 'task' }];

  /* When */
  const commands = skillCommands(entries);

  /* Then */
  assert.deepEqual(commands, ['grill-me', 'task']);
});

test('two plugins with a skill of the same name are each typed with their plugin', () => {
  /* Given */
  const entries = [{ name: 'tdd', plugin: 'mattpocock-skills' }, { name: 'tdd', plugin: 'movelab-claude-skills' }];

  /* When */
  const commands = skillCommands(entries);

  /* Then */
  assert.deepEqual(commands, ['mattpocock-skills:tdd', 'movelab-claude-skills:tdd']);
});

test('the user\'s own skill keeps the plain name when a plugin has one too', () => {
  /* Given */
  const entries = [{ name: 'review' }, { name: 'review', plugin: 'tools' }];

  /* When */
  const commands = skillCommands(entries);

  /* Then */
  assert.deepEqual(commands, ['review', 'tools:review']);
});

test('the same skill found twice is one skill, not a clash', () => {
  /* Given */
  const entries = [{ name: 'grill-me', plugin: 'mattpocock-skills' }, { name: 'grill-me', plugin: 'mattpocock-skills' }];

  /* When */
  const commands = skillCommands(entries);

  /* Then */
  assert.deepEqual(commands, ['grill-me']);
});

test('a project lists only the skills every project doesn\'t already have', () => {
  /* Given */
  const everywhere = [{ name: 'grill-me', plugin: 'mattpocock-skills' }];
  const byProject = { '/code/app': [{ name: 'release' }, { name: 'grill-me', plugin: 'mattpocock-skills' }], '/code/site': [] };

  /* When */
  const skills = routeSkills(everywhere, byProject);

  /* Then */
  assert.deepEqual(skills, { everywhere: ['grill-me'], byProject: { '/code/app': ['release'] } });
});

test('the frontmatter gives the name, and user-invocable: false takes the skill off the list', () => {
  /* Given */
  const named = '---\nname: grill-me\ndescription: A relentless interview.\ndisable-model-invocation: true\n---\n\nCall grilling.';
  const hidden = '---\nname: "helper"\nuser-invocable: false\n---\n';

  /* When */
  const read = [readSkillFrontmatter(named), readSkillFrontmatter(hidden), readSkillFrontmatter('No frontmatter.')];

  /* Then */
  assert.deepEqual(read, [
    { name: 'grill-me', userInvocable: true },
    { name: 'helper', userInvocable: false },
    { userInvocable: true },
  ]);
});
