import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BUGSNAG_TOKEN_SECRET, BugsnagConnectionService} from '../src/application/services/bugsnag-connection-service';
import {SettingsService} from '../src/application/services/settings-service';
import {BugsnagApiError} from '../src/application/ports/bugsnag-api';
import type {BugsnagApi} from '../src/application/ports/bugsnag-api';
import type {SecretStore} from '../src/application/ports/secret-store';
import type {SettingsStore} from '../src/application/ports/settings-store';
import type {BugsnagProject} from '../src/domain/bugsnag/model';

const GOOD = 'good-token-1234';
const BAD = 'bad-token-9999';

function memorySettings(): {store: SettingsStore; dump: () => string} {
    const values = new Map<string, unknown>();
    return {
        store: {
            get: <T>(key: string) => (values.has(key) ? (structuredClone(values.get(key)) as T) : null),
            set: (key, value) => void values.set(key, structuredClone(value)),
            delete: (key) => void values.delete(key),
        },
        dump: () => JSON.stringify([...values]),
    };
}

function memorySecrets(): SecretStore & {values: Map<string, string>} {
    const values = new Map<string, string>();
    return {
        values,
        read: (name) => values.get(name) ?? null,
        write: (name, value) => void values.set(name, value),
        remove: (name) => void values.delete(name),
    };
}

const PROJECTS: BugsnagProject[] = [
    {id: 'api', name: 'Connect API', slug: 'api', htmlUrl: null},
    {id: 'web', name: 'Connect Web', slug: 'web', htmlUrl: null},
];

/** An API that accepts GOOD, refuses BAD as unauthorized and is unreachable for anything else. */
function apiFor(token: string): BugsnagApi {
    const listProjects = async (): Promise<BugsnagProject[]> => {
        if (token === GOOD) return PROJECTS;
        if (token === BAD) throw new BugsnagApiError('unauthorized', 'refused', 401);
        throw new BugsnagApiError('unreachable', 'offline');
    };
    return {listProjects} as unknown as BugsnagApi;
}

function service(options: {mcp?: boolean} = {}) {
    const settings = memorySettings();
    const secrets = memorySecrets();
    const logged: string[] = [];
    const record = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
    const bugsnag = new BugsnagConnectionService({
        secrets,
        api: apiFor,
        settings: new SettingsService(settings.store),
        mcpServers: {has: (name) => (options.mcp ?? true) && name === 'bugsnag'},
        localProjects: () => [
            {path: '/code/connect', name: 'connect'},
            {path: '/code/studio', name: 'studio'},
        ],
        log: {debug: record, info: record, warn: record, error: record},
    });
    return {bugsnag, settings, secrets, logged};
}

test('a good token is saved in the secret store and never in the settings', async () => {
    /* Given */
    const {bugsnag, settings, secrets} = service();

    /* When */
    const view = await bugsnag.saveToken(`  ${GOOD}  `);

    /* Then */
    assert.equal(secrets.values.get(BUGSNAG_TOKEN_SECRET), GOOD);
    assert.ok(!settings.dump().includes(GOOD));
    assert.equal(view.tokenLastFour, '1234');
    assert.deepEqual(view.status, {ok: true, line: '✓ 2 projects visible', projectCount: 2});
});

test('what goes to the renderer never holds the token, nor do the logs', async () => {
    /* Given */
    const {bugsnag, logged} = service();
    const saved = await bugsnag.saveToken(GOOD);

    /* When */
    const view = await bugsnag.view();

    /* Then */
    assert.ok(!JSON.stringify(saved).includes(GOOD));
    assert.ok(!JSON.stringify(view).includes(GOOD));
    assert.ok(!logged.some((line) => line.includes(GOOD)));
});

test('a wrong token is not saved and says why in plain words', async () => {
    /* Given */
    const {bugsnag, secrets} = service();

    /* When */
    const view = await bugsnag.saveToken(BAD);

    /* Then */
    assert.equal(secrets.values.has(BUGSNAG_TOKEN_SECRET), false);
    assert.equal(view.tokenLastFour, null);
    assert.equal(view.status?.ok, false);
    assert.match(view.status!.line, /didn't accept this token/);
});

test('a wrong token keeps the token saved before it', async () => {
    /* Given */
    const {bugsnag, secrets} = service();
    await bugsnag.saveToken(GOOD);

    /* When */
    const view = await bugsnag.saveToken(BAD);

    /* Then */
    assert.equal(secrets.values.get(BUGSNAG_TOKEN_SECRET), GOOD);
    assert.equal(view.tokenLastFour, '1234');
});

test('when Bugsnag cannot be reached the view keeps the stored projects and says so', async () => {
    /* Given */
    const {bugsnag, secrets} = service();
    bugsnag.setProject('api', {optedIn: true, localProject: '/code/connect'}, 'Connect API');
    secrets.write(BUGSNAG_TOKEN_SECRET, 'unknown-token-0000');

    /* When */
    const view = await bugsnag.view();

    /* Then */
    assert.match(view.status!.line, /Couldn't reach Bugsnag/);
    assert.deepEqual(view.projects, [
        {id: 'api', name: 'Connect API', optedIn: true, localProject: '/code/connect', missing: false},
    ]);
});

test('opt-in, links and thresholds survive a round trip through the settings', async () => {
    /* Given */
    const {bugsnag} = service();
    await bugsnag.saveToken(GOOD);

    /* When */
    bugsnag.setProject('api', {optedIn: true, localProject: '/code/connect'}, 'Connect API');
    bugsnag.setProject('web', {optedIn: true, localProject: '/code/connect'}, 'Connect Web');
    bugsnag.setTrending({multiplier: 4, minEvents: 50});
    const view = await bugsnag.view();

    /* Then */
    assert.deepEqual(
        view.projects.map((row) => [row.id, row.optedIn, row.localProject]),
        [
            ['api', true, '/code/connect'],
            ['web', true, '/code/connect'],
        ],
    );
    assert.deepEqual(view.trending, {multiplier: 4, minEvents: 50});
});

test('a Bugsnag project cannot be linked to a folder that is not a local project', () => {
    /* Given */
    const {bugsnag} = service();

    /* When */
    const linking = () => bugsnag.setProject('api', {localProject: '/somewhere/else'});

    /* Then */
    assert.throws(linking, /not a local project/);
    assert.deepEqual(bugsnag.settings().projects, []);
});

test('removing the token keeps the projects and links for later', async () => {
    /* Given */
    const {bugsnag, secrets} = service();
    await bugsnag.saveToken(GOOD);
    bugsnag.setProject('api', {optedIn: true, localProject: '/code/connect'});

    /* When */
    const view = bugsnag.removeToken();

    /* Then */
    assert.equal(secrets.values.has(BUGSNAG_TOKEN_SECRET), false);
    assert.equal(view.tokenLastFour, null);
    assert.equal(bugsnag.api(), null);
    assert.equal(bugsnag.settings().projects[0].localProject, '/code/connect');
});

test('without the bugsnag MCP the view says Fix sessions need it', async () => {
    /* Given */
    const {bugsnag} = service({mcp: false});

    /* When */
    const view = await bugsnag.saveToken(GOOD);

    /* Then */
    assert.equal(view.mcpMissing, true);
});
