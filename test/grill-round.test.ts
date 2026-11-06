import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {parseRound, roundOfTurn} from '../src/domain/grill/round';

/**
 * A grilling round read out of the text Claude ended its turn with, in every
 * header shape Claude writes, and the turn's last text block as the round.
 */

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'grill-rounds', name), 'utf8');

const headers = (text: string) => parseRound(text)?.questions.map((q) => [q.number, q.title, q.reason]);

test('a round with bold number and bold title reads every question, its reason and recommendation', () => {
    /* Given */
    const text = fixture('bold-number-and-title.md');

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.equal(round?.preamble, 'Settled last round: uploads go straight to object storage, no local staging.');
    assert.deepEqual(round?.questions, [
        {
            number: 1,
            title: 'Resize images on upload?',
            reason: 'Thumbnails are built on every page view today.\nDoing it once on upload moves that cost to a background job.',
            recommendation: 'Yes: resize on upload, keep the original next to it.',
        },
        {
            number: 2,
            title: 'Where do the thumbnails live?',
            reason: 'Next to the original or in a bucket of their own.',
            recommendation: 'Next to the original, under a `thumbs/` prefix.',
        },
        {
            number: 3,
            title: 'Keep the old image route?',
            reason: 'Two mobile clients still call it.',
            recommendation: 'Keep it for one more release, then drop it.',
        },
    ]);
});

test('bold around number and title is read, also with the colon inside and the recommendation on the next line', () => {
    /* Given */
    const text = fixture('bold-around-number-and-title.md');

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.deepEqual(
        round?.questions.map((q) => [q.number, q.title, q.reason, q.recommendation]),
        [
            [
                1,
                'Cache the search index?',
                'Rebuilding takes four seconds at startup.',
                'Yes, cache it on disk and rebuild when the schema version changes.',
            ],
            [2, 'Which hashing scheme?', '', 'Content hash of the schema file; the version number is often forgotten.'],
        ],
    );
    assert.equal(round?.preamble, '');
});

test('plain, heading, dotted, colon and bare-number headers are read, with any rule between questions', () => {
    /* Given */
    const text = fixture('plain-and-loose-headers.md');

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.equal(round?.preamble, 'Two loose ends before the release.');
    assert.deepEqual(
        round?.questions.map((q) => [q.number, q.title, q.reason, q.recommendation]),
        [
            [
                1,
                'Retry failed webhooks',
                'Partners see gaps when their endpoint is down for a minute.',
                'Retry three times with backoff, then park it in a dead-letter table.',
            ],
            [3, 'Log the payload?', 'Payloads can carry personal data.', 'Log the event id and status only.'],
            [4, 'Alert on parking', 'Someone should hear about a parked webhook.', 'A daily digest, not a page.'],
            [5, 'Expose a replay button', 'Support asks for it weekly.', 'Yes, admin-only.'],
        ],
    );
});

test('a Dutch round numbers its questions V1 and Vraag 2', () => {
    /* Given */
    const text = fixture('dutch-round.md');

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.equal(round?.preamble, "Kort samengevat: de export draait voortaan 's nachts.");
    assert.deepEqual(
        round?.questions.map((q) => [q.number, q.title, q.recommendation]),
        [
            [1, 'CSV of Excel?', 'Excel, met CSV als tweede optie in het menu.'],
            [2, 'Hoe lang bewaren we exports?', 'Dertig dagen, daarna weg.'],
        ],
    );
});

test('each separator is accepted between number and title', () => {
    /* Given */
    const texts = ['-', '–', '—', ':', '.'].map((sep) => `❓ Q7 ${sep} Ship it: Ready.\n➡️ Yes.`);

    /* When */
    const parsed = texts.map(headers);

    /* Then */
    assert.deepEqual(
        parsed,
        texts.map(() => [[7, 'Ship it', 'Ready.']]),
    );
});

test('the number may carry a prefix of up to eight letters, or none', () => {
    /* Given */
    const texts = ['Q2', 'V2', 'Vraag 2', 'Question 2', '2'].map((n) => `❓ **${n}** - **Ship it**: Ready.\n➡️ Yes.`);

    /* When */
    const parsed = texts.map(headers);

    /* Then */
    assert.deepEqual(
        parsed,
        texts.map(() => [[2, 'Ship it', 'Ready.']]),
    );
});

test('a prefix longer than eight letters is not a question number', () => {
    /* Given */
    const text = '❓ Checkpoint9 - Ship it: Ready.\n➡️ Yes.';

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.equal(round, null);
});

test('the heading mark may come before or after the question mark', () => {
    /* Given */
    const texts = ['## ❓ Q1 - Ship it: Ready.\n➡️ Yes.', '❓ ### **Q1** - **Ship it**: Ready.\n➡️ Yes.'];

    /* When */
    const parsed = texts.map(headers);

    /* Then */
    assert.deepEqual(parsed, [[[1, 'Ship it', 'Ready.']], [[1, 'Ship it', 'Ready.']]]);
});

test('a plain title runs to the first colon, and a header without one is all title', () => {
    /* Given */
    const withColon = '❓ Q1 - Use UTC: everywhere: even in the logs.\n➡️ Yes.';
    const without = '❓ Q1 - Use UTC everywhere?\n➡️ Yes.';

    /* When */
    const parsed = [headers(withColon), headers(without)];

    /* Then */
    assert.deepEqual(parsed, [[[1, 'Use UTC', 'everywhere: even in the logs.']], [[1, 'Use UTC everywhere?', '']]]);
});

test('the reason runs over several lines up to the recommendation, without rules', () => {
    /* Given */
    const text = [
        '❓ **Q1** - **Batch the emails?**: One per event floods inboxes.',
        '',
        'A digest every hour is what most people asked for.',
        '',
        '➡️ Hourly digest.',
    ].join('\n');

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.equal(
        round?.questions[0].reason,
        'One per event floods inboxes.\n\nA digest every hour is what most people asked for.',
    );
});

test('a recommendation keeps its following lines up to a rule', () => {
    /* Given */
    const text = [
        '❓ **Q1** - **Batch the emails?**: Floods inboxes.',
        '➡️ Hourly digest.',
        '',
        'Users can opt back in to instant mails.',
        '',
        '---',
        '',
        '❓ **Q2** - **Keep the unsubscribe page?**: It is linked from old mails.',
        '➡️ Yes.',
    ].join('\n');

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.equal(round?.questions[0].recommendation, 'Hourly digest.\n\nUsers can opt back in to instant mails.');
});

test('a recommendation keeps its following lines up to the next question when no rule comes first', () => {
    /* Given */
    const text = '❓ Q1 - First: A.\n➡️ One,\nand more.\n\n❓ Q2 - Second: B.\n➡️ Two.';

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.deepEqual(
        round?.questions.map((q) => q.recommendation),
        ['One,\nand more.', 'Two.'],
    );
});

test('the last recommendation stops at the first blank line, leaving the closing prose out', () => {
    /* Given */
    const text = fixture('closing-prose.md');

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.deepEqual(
        round?.questions.map((q) => q.recommendation),
        [
            'Yes: one file per scope,\nwith the machine one ignored by git.',
            'Migrate on first launch and keep a backup.',
        ],
    );
});

test('a recommendation written on the line after a bare arrow is still read', () => {
    /* Given */
    const text = '❓ Q1 - Ship it: Ready.\n➡️\nYes, on Monday.\n\nThanks!';

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.equal(round?.questions[0].recommendation, 'Yes, on Monday.');
});

test('an arrow without its variation selector still marks the recommendation', () => {
    /* Given */
    const text = '❓ Q1 - Ship it: Ready.\n➡ Yes.';

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.equal(round?.questions[0].recommendation, 'Yes.');
});

test('a question line without a number is not a question, and before the first one it is preamble', () => {
    /* Given */
    const text = fixture('unnumbered-question-line.md');

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.equal(round?.preamble, '❓ Before the round: should I keep going after this one?');
    assert.deepEqual(
        round?.questions.map((q) => q.title),
        ['Pin the Node version?'],
    );
});

test('a numbered question without a recommendation makes the whole text no round', () => {
    /* Given */
    const text = fixture('missing-recommendation.md');

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.equal(round, null);
});

test('text without a numbered question is no round', () => {
    /* When */
    const parsed = [
        parseRound(''),
        parseRound('All tests pass. ❓ nothing to ask.'),
        parseRound('❓ Just a thought, no number.\n➡️ ok'),
        parseRound('❓ Top 3 risks are below.\n➡️ ok'),
    ];

    /* Then */
    assert.deepEqual(parsed, [null, null, null, null]);
});

test('a trailing rule is not part of the preamble', () => {
    /* Given */
    const text = 'Recap.\n\n---\n\n❓ Q1 - Ship it: Ready.\n➡️ Yes.';

    /* When */
    const round = parseRound(text);

    /* Then */
    assert.equal(round?.preamble, 'Recap.');
});

test('inline choices in a reason are split out, with the letter the recommendation picks', () => {
    /* Given */
    const text = fixture('inline-choices.md');

    /* When */
    const [first, second, third] = parseRound(text)?.questions ?? [];

    /* Then */
    assert.deepEqual(first.choices, {
        lead: 'Only the database row and its uploads cost space.',
        list: [
            {letter: 'a', text: 'Forever'},
            {letter: 'b', text: '30 days, then purge'},
            {letter: 'c', text: 'Until an admin empties the bin'},
        ],
        after: 'Admins rarely empty anything by hand.',
    });
    assert.equal(first.recommendedChoice, 'b');
    assert.equal('choices' in second, false);
    assert.equal('recommendedChoice' in second, false);
    assert.deepEqual(
        third.choices?.list.map((c) => c.text),
        ['newest first', 'by name', 'by size'],
    );
    assert.equal(third.recommendedChoice, 'a');
});

test('a question without inline choices has neither choices nor a recommended choice', () => {
    /* Given */
    const text = '❓ Q1 - Ship it: Ready.\n➡️ (a) Yes.';

    /* When */
    const [question] = parseRound(text)?.questions ?? [];

    /* Then */
    assert.deepEqual(question, {number: 1, title: 'Ship it', reason: 'Ready.', recommendation: '(a) Yes.'});
});

// ── A turn ──

const ROUND = '❓ **Q1** - **Ship it?**: Ready.\n\n➡️ Yes.';

test('the round is the turn’s last text block, named by its id', () => {
    /* Given */
    const turn = {
        texts: [
            {id: 'a', text: 'Let me look around first.'},
            {id: 'b', text: ROUND},
        ],
    };

    /* When */
    const posted = roundOfTurn(turn);

    /* Then */
    assert.equal(posted?.id, 'b');
    assert.equal(posted?.round.questions[0].title, 'Ship it?');
});

test('text written after a round means the turn has no round', () => {
    /* Given */
    const turn = {
        texts: [
            {id: 'a', text: ROUND},
            {id: 'b', text: 'Actually, let me check one more thing.'},
        ],
    };

    /* When */
    const posted = roundOfTurn(turn);

    /* Then */
    assert.equal(posted, null);
});

test('a turn without text has no round', () => {
    /* When */
    const posted = roundOfTurn({texts: []});

    /* Then */
    assert.equal(posted, null);
});
