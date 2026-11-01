import {test} from 'node:test';
import assert from 'node:assert/strict';

import {BatteryService} from '../src/application/services/battery-service';
import {fakeDeviceConnection, fakeTimers} from './support/fakes';
import type {MacBattery} from '../src/domain/phone/protocol';

/**
 * The Mac's battery on the phone: told on welcome, told again only when it
 * changes, and read only while a phone is connected.
 */

function harness(initial: MacBattery | null) {
    let level = initial;
    let reads = 0;
    const timers = fakeTimers();
    const service = new BatteryService({
        gauge: {
            read: async () => {
                reads++;
                return level;
            },
        },
        timers,
    });
    return {
        service,
        timers,
        set(battery: MacBattery | null) {
            level = battery;
        },
        reads: () => reads,
    };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a welcomed phone is told the level', async () => {
    /* Given */
    const h = harness({percent: 64, charging: false});
    const phone = fakeDeviceConnection();

    /* When */
    h.service.connected(phone);
    await settle();

    /* Then */
    assert.deepEqual(phone.of('mac-battery'), [{type: 'mac-battery', battery: {percent: 64, charging: false}}]);
});

test('a Mac without a battery tells the phone there is none', async () => {
    /* Given */
    const h = harness(null);
    const phone = fakeDeviceConnection();

    /* When */
    h.service.connected(phone);
    await settle();

    /* Then */
    assert.deepEqual(phone.of('mac-battery'), [{type: 'mac-battery', battery: null}]);
});

test('every phone is told when the level changes, and nobody when it does not', async () => {
    /* Given */
    const h = harness({percent: 64, charging: false});
    const a = fakeDeviceConnection('conn-a', 'phone-a');
    const b = fakeDeviceConnection('conn-b', 'phone-b');
    h.service.connected(a);
    h.service.connected(b);
    await settle();
    a.clear();
    b.clear();

    /* When */
    await h.service.read();
    h.set({percent: 63, charging: false});
    await h.service.read();

    /* Then */
    const expected = [{type: 'mac-battery', battery: {percent: 63, charging: false}}];
    assert.deepEqual(a.of('mac-battery'), expected);
    assert.deepEqual(b.of('mac-battery'), expected);
});

test('the level is read once a minute while a phone is connected, and not after it leaves', async () => {
    /* Given */
    const h = harness({percent: 64, charging: false});
    const phone = fakeDeviceConnection();
    h.service.connected(phone);
    await settle();
    const afterWelcome = h.reads();

    /* When */
    h.timers.tick();
    await settle();
    const whileConnected = h.reads();
    h.service.disconnected(phone);
    h.timers.tick();
    await settle();

    /* Then */
    assert.equal(whileConnected, afterWelcome + 1);
    assert.equal(h.reads(), whileConnected);
});
