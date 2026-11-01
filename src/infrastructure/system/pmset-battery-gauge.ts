/** `pmset -g batt` behind the BatteryGauge port. Needs no privileges. */
import {execFile} from 'node:child_process';
import {parsePmsetBattery} from '../../domain/power/battery';
import type {BatteryGauge} from '../../application/ports/battery';
import type {MacBattery} from '../../domain/phone/protocol';

const PMSET = '/usr/bin/pmset';

export class PmsetBatteryGauge implements BatteryGauge {
    public read(): Promise<MacBattery | null> {
        if (process.platform !== 'darwin') return Promise.resolve(null);
        return new Promise((resolve) => {
            execFile(PMSET, ['-g', 'batt'], {timeout: 10_000}, (err, stdout) =>
                resolve(err ? null : parsePmsetBattery(stdout)),
            );
        });
    }
}
