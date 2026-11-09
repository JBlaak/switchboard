/**
 * The order of each pinned section (#379): pinning puts a pin at the end of
 * its section, unpinning takes it out, and dragging (or ⌥↑ / ⌥↓) moves a
 * pin, or a group's pins, next to another.
 *
 * Every change rewrites the section's positions whole, 0 to n - 1, from the
 * order the repository answers. That also places any pin stored before
 * positions existed, so after the first change a section has no unplaced
 * pins left. The rules for the order are `domain/pin/pin-order`'s.
 */
import {appendPin, moveBlock, pinKey, withoutPin} from '../../domain/pin/pin-order';
import type {PinRef, PinSection, PinTarget} from '../../domain/pin/pin-order';
import type {SessionRepository} from '../ports/session-repository';

export class PinOrderService {
    constructor(private readonly repository: Pick<SessionRepository, 'getPinOrder' | 'setPinOrder'>) {}

    /** The section's pins in order. */
    public order(section: PinSection): PinRef[] {
        return this.repository.getPinOrder(section);
    }

    /**
     * Pin or unpin `ref` through `flip`, which stores the pin itself and
     * answers whether it is pinned now; the section's order follows. Answers
     * what `flip` did and the section's order after it.
     */
    public toggle<T>(
        section: PinSection,
        ref: PinRef,
        flip: () => T,
        pinned: (result: T) => boolean,
    ): {result: T; order: PinRef[]} {
        const result = flip();
        const before = this.repository.getPinOrder(section);
        const order = pinned(result) ? appendPin(before, ref, pinKey) : withoutPin(before, ref, pinKey);
        this.repository.setPinOrder(order);
        return {result, order};
    }

    /** Move `moving` next to `target` and answer the section's new order. */
    public move(section: PinSection, moving: readonly PinRef[], target: PinTarget): PinRef[] {
        const order = moveBlock(this.repository.getPinOrder(section), moving, target, pinKey);
        this.repository.setPinOrder(order);
        return order;
    }
}
