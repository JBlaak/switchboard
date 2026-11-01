/**
 * The Mac's battery level, for the phone (#194).
 *
 * Answers null rather than rejecting when there is nothing to show: a Mac
 * without a battery, or `pmset` failing.
 */
import type {MacBattery} from '../../domain/phone/protocol';

export interface BatteryGauge {
    read(): Promise<MacBattery | null>;
}
