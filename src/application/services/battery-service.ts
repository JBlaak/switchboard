/**
 * The Mac's battery on the phone (#194): every welcomed phone is told the
 * level, and told again whenever it or the charging changes.
 *
 * The level is only looked at while a phone is connected, once a minute;
 * with no phone there is nobody to tell.
 */
import {sameBattery} from '../../domain/power/battery';
import type {MacBattery} from '../../domain/phone/protocol';
import type {BatteryGauge} from '../ports/battery';
import type {TimerHandle, Timers} from '../ports/clock';
import type {DeviceConnection} from '../ports/phone-access';

/** How often the level is read while a phone is connected. */
export const BATTERY_POLL_MS = 60_000;

export interface BatteryServiceDeps {
    gauge: BatteryGauge;
    timers: Timers;
}

export class BatteryService {
    private readonly phones = new Map<string, DeviceConnection>();
    /** As last read; undefined until the first read. */
    private last: MacBattery | null | undefined = undefined;
    private poll: TimerHandle | null = null;

    constructor(private readonly deps: BatteryServiceDeps) {}

    /** A phone was welcomed: it gets the level as read now. */
    public connected(connection: DeviceConnection): void {
        this.phones.set(connection.id, connection);
        if (this.poll === null) this.poll = this.deps.timers.setInterval(() => void this.read(), BATTERY_POLL_MS);
        void this.deps.gauge.read().then((battery) => {
            if (!this.phones.has(connection.id)) return;
            this.last = battery;
            connection.send({type: 'mac-battery', battery});
        });
    }

    public disconnected(connection: DeviceConnection): void {
        this.phones.delete(connection.id);
        if (this.phones.size === 0 && this.poll !== null) {
            this.deps.timers.clearInterval(this.poll);
            this.poll = null;
        }
    }

    /** Reads the level, and tells every phone when it changed. */
    public async read(): Promise<void> {
        const battery = await this.deps.gauge.read();
        if (this.last !== undefined && sameBattery(this.last, battery)) return;
        this.last = battery;
        for (const phone of this.phones.values()) phone.send({type: 'mac-battery', battery});
    }
}
