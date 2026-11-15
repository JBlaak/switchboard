/**
 * Not landed's read: the user's open PRs kept to the known repositories,
 * kept for 30 s, shared while under way, and the last good answer standing
 * when GitHub cannot be read.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NOT_LANDED_FRESH_MS, NotLandedService} from '../src/application/services/not-landed-service';
import type {OpenPullRequest} from '../src/domain/merge-manager/not-landed';

function pr(repository: string, number: number): OpenPullRequest {
    return {
        repository,
        number,
        title: `PR ${number}`,
        url: `https://github.com/${repository}/pull/${number}`,
        isDraft: false,
        createdAt: 1_000 + number,
        headRef: `branch-${number}`,
        reviewDecision: null,
        mergeable: 'MERGEABLE',
        checks: null,
        reviewRequested: [],
        changesRequestedBy: [],
        approvedBy: [],
    };
}

function world(answers: (OpenPullRequest[] | null | Error)[], known: string[] = ['JBlaak/switchboard']) {
    const clock = {time: 0, now: () => clock.time};
    let reads = 0;
    const service = new NotLandedService({
        github: {
            openPullRequests: async () => {
                reads++;
                const answer = answers.shift() ?? null;
                if (answer instanceof Error) throw answer;
                return answer;
            },
        },
        knownRepositories: async () => known,
        clock,
    });
    return {service, clock, reads: () => reads};
}

test('only the PRs in a known repository are read, case aside', async () => {
    /* Given */
    const {service} = world(
        [[pr('jblaak/Switchboard', 1), pr('MoveLab-Studio/Connect', 2), pr('JBlaak/switchboard', 3)]],
        ['JBlaak/switchboard'],
    );

    /* When */
    const read = await service.read();

    /* Then */
    assert.deepEqual(
        read?.map((p) => p.number),
        [1, 3],
    );
});

test('a good answer is kept for 30 s, then GitHub is asked again', async () => {
    /* Given */
    const {service, clock, reads} = world([[pr('JBlaak/switchboard', 1)], [pr('JBlaak/switchboard', 2)]]);
    await service.read();

    /* When */
    clock.time = NOT_LANDED_FRESH_MS - 1;
    const kept = await service.read();
    clock.time = NOT_LANDED_FRESH_MS;
    const fresh = await service.read();

    /* Then */
    assert.deepEqual(
        kept?.map((p) => p.number),
        [1],
    );
    assert.deepEqual(
        fresh?.map((p) => p.number),
        [2],
    );
    assert.equal(reads(), 2);
});

test('calls made while a read is under way share it', async () => {
    /* Given */
    const {service, reads} = world([[pr('JBlaak/switchboard', 1)]]);

    /* When */
    const [first, second] = await Promise.all([service.read(), service.read()]);

    /* Then */
    assert.equal(reads(), 1);
    assert.equal(first, second);
});

test('when GitHub cannot be read, the last good answer stands', async () => {
    /* Given */
    const {service, clock} = world([[pr('JBlaak/switchboard', 1)], null, new Error('gh crashed')]);
    await service.read();

    /* When */
    clock.time = NOT_LANDED_FRESH_MS;
    const afterNull = await service.read();
    const afterThrow = await service.read();

    /* Then */
    assert.deepEqual(
        afterNull?.map((p) => p.number),
        [1],
    );
    assert.deepEqual(
        afterThrow?.map((p) => p.number),
        [1],
    );
});

test('null when GitHub cannot be read and there never was a good answer, and asked again next time', async () => {
    /* Given */
    const {service, reads} = world([null, [pr('JBlaak/switchboard', 1)]]);

    /* When */
    const failed = await service.read();
    const retried = await service.read();

    /* Then */
    assert.equal(failed, null);
    assert.deepEqual(
        retried?.map((p) => p.number),
        [1],
    );
    assert.equal(reads(), 2);
});
