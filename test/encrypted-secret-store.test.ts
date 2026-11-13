import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EncryptedFileSecretStore} from '../src/infrastructure/fs/encrypted-secret-store';

/** A reversible stand-in for safeStorage: reversed base64, so the file never holds the plain text. */
const encryption = {
    encrypt: (text: string) => Buffer.from(Buffer.from(text, 'utf8').toString('base64').split('').reverse().join('')),
    decrypt: (data: Buffer) => Buffer.from(data.toString().split('').reverse().join(''), 'base64').toString('utf8'),
};

const quietLog = {debug() {}, info() {}, warn() {}, error() {}};

function store() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-secrets-'));
    return {directory, secrets: new EncryptedFileSecretStore(path.join(directory, 'secrets'), encryption, quietLog)};
}

test('a written secret reads back, and its file holds only the encrypted form, for the user alone', () => {
    /* Given */
    const {directory, secrets} = store();

    /* When */
    secrets.write('bugsnag-token', 'secret-value-1234');

    /* Then */
    assert.equal(secrets.read('bugsnag-token'), 'secret-value-1234');
    const file = path.join(directory, 'secrets', 'bugsnag-token.enc');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('secret-value-1234'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a removed or never written secret reads as null', () => {
    /* Given */
    const {secrets} = store();
    secrets.write('bugsnag-token', 'secret-value-1234');

    /* When */
    secrets.remove('bugsnag-token');

    /* Then */
    assert.equal(secrets.read('bugsnag-token'), null);
    assert.equal(secrets.read('never-written'), null);
});

test('a secret that cannot be decrypted reads as null', () => {
    /* Given */
    const {directory} = store();
    const failing = new EncryptedFileSecretStore(
        directory,
        {
            encrypt: (text) => Buffer.from(text),
            decrypt: () => {
                throw new Error('Keychain locked');
            },
        },
        quietLog,
    );
    failing.write('bugsnag-token', 'x');

    /* When */
    const read = failing.read('bugsnag-token');

    /* Then */
    assert.equal(read, null);
});

test('a name that could escape the folder is refused', () => {
    /* Given */
    const {secrets} = store();

    /* When */
    const writing = () => secrets.write('../settings', 'x');

    /* Then */
    assert.throws(writing, /not a secret name/);
});
