import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DnsSdAdvertiser, localHostName, type AdvertiserProcess } from '../src/infrastructure/phone/dns-sd-advertiser';
import { silentLog } from './support/fakes';

/** A spawn that records what it was asked to run and hands back killable fakes. */
function fakeSpawn() {
  const runs: Array<{ command: string; args: string[]; killed: boolean; exit: (code: number) => void }> = [];
  const spawn = (command: string, args: string[]): AdvertiserProcess => {
    const listeners: Array<(code: number | null, signal: string | null) => void> = [];
    const run = { command, args, killed: false, exit: (code: number) => listeners.forEach((l) => l(code, null)) };
    runs.push(run);
    return {
      kill() { run.killed = true; },
      on(event: string, listener: never) {
        if (event === 'exit') listeners.push(listener);
        return this;
      },
    } as AdvertiserProcess;
  };
  return { runs, spawn };
}

test('advertising registers the service with dns-sd, TXT records and all', () => {
  /* Given */
  const { runs, spawn } = fakeSpawn();
  const advertiser = new DnsSdAdvertiser({ log: silentLog, spawn });

  /* When */
  advertiser.advertise('Joris’s MacBook', 52100, { v: '1', fp: 'abc' });

  /* Then */
  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, '/usr/bin/dns-sd');
  assert.deepEqual(runs[0].args, ['-R', 'Joris’s MacBook', '_switchboard._tcp', 'local', '52100', 'v=1', 'fp=abc']);
  assert.equal(runs[0].killed, false);
});

test('withdrawing kills the dns-sd process', () => {
  /* Given */
  const { runs, spawn } = fakeSpawn();
  const advertiser = new DnsSdAdvertiser({ log: silentLog, spawn });
  advertiser.advertise('Mac', 1, {});

  /* When */
  advertiser.withdraw();
  advertiser.withdraw();

  /* Then */
  assert.equal(runs[0].killed, true);
});

test('advertising again replaces the running advertisement', () => {
  /* Given */
  const { runs, spawn } = fakeSpawn();
  const advertiser = new DnsSdAdvertiser({ log: silentLog, spawn });
  advertiser.advertise('Mac', 1, {});

  /* When */
  advertiser.advertise('Mac', 2, {});

  /* Then */
  assert.equal(runs.length, 2);
  assert.equal(runs[0].killed, true);
  assert.equal(runs[1].killed, false);
  assert.equal(runs[1].args[4], '2');
});

test('a dns-sd that exits on its own is forgotten, so withdraw has nothing to kill', () => {
  /* Given */
  const { runs, spawn } = fakeSpawn();
  const advertiser = new DnsSdAdvertiser({ log: silentLog, spawn });
  advertiser.advertise('Mac', 1, {});

  /* When */
  runs[0].exit(1);
  advertiser.withdraw();

  /* Then */
  assert.equal(runs[0].killed, false);
});

test('the host name is the first label of the machine name, under .local', () => {
  /* Given */
  const advertiser = new DnsSdAdvertiser({ log: silentLog, hostname: () => 'Joris-MBP.fritz.box' });

  /* When */
  const name = advertiser.hostName();

  /* Then */
  assert.equal(name, 'joris-mbp.local');
  assert.equal(localHostName('joris-mbp.local.'), 'joris-mbp.local');
  assert.equal(localHostName('joris-mbp'), 'joris-mbp.local');
});

test('the Mac\'s own Bonjour name wins over the host name, which stays the fallback', () => {
  /* Given */
  const named = new DnsSdAdvertiser({ log: silentLog, hostname: () => 'mac', localName: () => 'Joriss-MacBook-Pro-2.local' });
  const unnamed = new DnsSdAdvertiser({ log: silentLog, hostname: () => 'Joris-MBP.fritz.box', localName: () => null });

  /* When */
  const names = [named.hostName(), unnamed.hostName()];

  /* Then */
  assert.deepEqual(names, ['Joriss-MacBook-Pro-2.local', 'joris-mbp.local']);
});
