import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {bundledAgentVersion} from '../src/infrastructure/ssh/agent-bundle';

/** The agent's build stamp is what a VM's agent is compared against, not the app's version. */

test('the bundled agent version is the stamp written beside the bundle', () => {
    /* Given */
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stamp-'));
    fs.writeFileSync(path.join(agentDir, 'VERSION'), '2.11.9+abc123def456\n');

    /* When */
    const version = bundledAgentVersion({agentDir}, '2.11.9');

    /* Then */
    assert.equal(version, '2.11.9+abc123def456');
});

test("without a stamp the app's version stands in", () => {
    /* Given */
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stamp-'));

    /* When */
    const version = bundledAgentVersion({agentDir}, '2.11.9');

    /* Then */
    assert.equal(version, '2.11.9');
});
