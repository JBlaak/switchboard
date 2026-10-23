import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OpensslIdentityStore, certificateFingerprint, type Encryption, type Exec,
} from '../src/infrastructure/phone/identity-store';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-phone-identity-'));
  dirs.push(dir);
  return dir;
}

/** Reversible, and leaves nothing of the plain text readable. */
const fakeEncryption: Encryption = {
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').map(b => b ^ 0x5a)),
  decrypt: (data) => Buffer.from(data.map(b => b ^ 0x5a)).toString('utf8'),
};

function storeIn(directory: string, exec?: Exec): OpensslIdentityStore {
  return new OpensslIdentityStore({ directory, encryption: fakeEncryption, exec });
}

/** Every file under the directory, read as text. */
function filesIn(directory: string): string[] {
  return fs.readdirSync(directory).map(name => fs.readFileSync(path.join(directory, name), 'latin1'));
}

test('the first load makes an EC P-256 identity for CN Switchboard, valid for about ten years', async () => {
  /* Given */
  const store = storeIn(tempDir());

  /* When */
  const identity = await store.load();

  /* Then */
  const cert = new X509Certificate(identity.certPem);
  assert.match(cert.subject, /CN=Switchboard/);
  assert.equal(cert.publicKey.asymmetricKeyType, 'ec');
  assert.equal(cert.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  const years = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / (365 * 24 * 3600 * 1000);
  assert.ok(years > 9.9 && years < 10.1, `valid for ${years} years`);
  assert.match(identity.keyPem, /-----BEGIN PRIVATE KEY-----/);
});

/** The system openssl as well as the one on PATH: macOS ships LibreSSL in /usr/bin. */
const openssls = ['openssl', ...(fs.existsSync('/usr/bin/openssl') ? ['/usr/bin/openssl'] : [])];

for (const openssl of openssls) {
  test(`the certificate from ${openssl} names its curve rather than spelling out its parameters`, async () => {
    /* Given */
    const store = new OpensslIdentityStore({ directory: tempDir(), encryption: fakeEncryption, openssl });

    /* When */
    const identity = await store.load();

    /* Then */
    // A named P-256 key is 91 bytes of SPKI; spelled-out parameters, which
    // Electron's BoringSSL refuses, make it well over 200.
    const spki = new X509Certificate(identity.certPem).publicKey.export({ type: 'spki', format: 'der' });
    assert.equal(spki.length, 91);
  });
}

test('a later load answers the same identity, also from a new store on the same directory', async () => {
  /* Given */
  const directory = tempDir();
  const first = await storeIn(directory).load();

  /* When */
  const again = await storeIn(directory).load();

  /* Then */
  assert.deepEqual(again, first);
});

test('concurrent loads make only one identity', async () => {
  /* Given */
  const store = storeIn(tempDir());

  /* When */
  const [a, b] = await Promise.all([store.load(), store.load()]);

  /* Then */
  assert.equal(a.fingerprint, b.fingerprint);
});

test('reset makes a different identity, and later loads answer it', async () => {
  /* Given */
  const directory = tempDir();
  const store = storeIn(directory);
  const old = await store.load();

  /* When */
  const fresh = await store.reset();

  /* Then */
  assert.notEqual(fresh.fingerprint, old.fingerprint);
  assert.notEqual(fresh.keyPem, old.keyPem);
  assert.equal((await store.load()).fingerprint, fresh.fingerprint);
  assert.equal((await storeIn(directory).load()).fingerprint, fresh.fingerprint);
});

test('the key is written only encrypted', async () => {
  /* Given */
  const directory = tempDir();

  /* When */
  const identity = await storeIn(directory).load();

  /* Then */
  for (const contents of filesIn(directory)) {
    assert.doesNotMatch(contents, /PRIVATE KEY/);
    assert.ok(!contents.includes(identity.keyPem.split('\n')[1]), 'no line of the key in plain text');
  }
  assert.equal(fs.readdirSync(directory).length, 2, 'only the encrypted key and the certificate');
});

/** Runs openssl for real, the way the store's own exec does. */
function runOpenssl(file: string, args: readonly string[], env: Record<string, string>): string {
  return execFileSync(file, [...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
}

test('the key file openssl writes only ever holds an encrypted key, and is gone afterwards', async () => {
  /* Given */
  let keyFile = '';
  let keyFileContents = '';
  let passphraseInArgs = true;
  const recording: Exec = async (file, args, env) => {
    const output = runOpenssl(file, args, env);
    keyFile = args[args.indexOf('-keyout') + 1];
    keyFileContents = fs.readFileSync(keyFile, 'utf8');
    passphraseInArgs = Object.values(env).some(value => args.some(arg => arg.includes(value)));
    return output;
  };

  /* When */
  const identity = await storeIn(tempDir(), recording).load();

  /* Then */
  assert.match(keyFileContents, /^-----BEGIN ENCRYPTED PRIVATE KEY-----/);
  assert.ok(!keyFileContents.includes(identity.keyPem.split('\n')[1]), 'no line of the plain key in the file');
  assert.equal(passphraseInArgs, false, 'the passphrase reaches openssl only through its environment');
  assert.equal(fs.existsSync(path.dirname(keyFile)), false, 'the temp directory is removed');
  assert.match(identity.keyPem, /^-----BEGIN PRIVATE KEY-----/);
});

test('the fingerprint matches openssl x509 -fingerprint -sha256 for the same certificate', async () => {
  /* Given */
  const identity = await storeIn(tempDir()).load();

  /* When */
  const printed = execFileSync('openssl', ['x509', '-noout', '-fingerprint', '-sha256'],
    { input: identity.certPem, encoding: 'utf8' });

  /* Then */
  const expected = printed.trim().split('=').pop()!.replace(/:/g, '').toLowerCase();
  assert.match(identity.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(identity.fingerprint, expected);
  assert.equal(certificateFingerprint(identity.certPem), expected);
});

test('a key that does not match the stored certificate is replaced', async () => {
  // A crash between writing the key and the certificate leaves a pair that
  // does not belong together; it cannot serve TLS, so a new one is made.
  /* Given */
  const directory = tempDir();
  const first = await storeIn(directory).load();
  const other = await storeIn(tempDir()).load();
  fs.writeFileSync(path.join(directory, 'phone-server-cert.pem'), other.certPem);

  /* When */
  const loaded = await storeIn(directory).load();

  /* Then */
  assert.notEqual(loaded.fingerprint, first.fingerprint);
  assert.notEqual(loaded.fingerprint, other.fingerprint);
  assert.ok(new X509Certificate(loaded.certPem).checkPrivateKey(createPrivateKey(loaded.keyPem)));
});

test('a failing openssl rejects the load, and the next load tries again', async () => {
  /* Given */
  let failing = true;
  const flaky: Exec = (file, args, env) => failing
    ? Promise.reject(new Error('openssl: not found'))
    : Promise.resolve(runOpenssl(file, args, env));
  const store = storeIn(tempDir(), flaky);
  await assert.rejects(store.load(), /not found/);
  failing = false;

  /* When */
  const identity = await store.load();

  /* Then */
  assert.match(identity.fingerprint, /^[0-9a-f]{64}$/);
});
