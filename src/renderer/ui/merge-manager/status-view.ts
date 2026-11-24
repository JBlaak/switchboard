/**
 * What the Merge manager's page by status says in words: the clock and the
 * repository's short name, a parked flag's cloth on Coming up, a lane's facts
 * beside its track, its not landed counts, the timeline's footer, the time
 * pins under the blocks, the kind line on a status card and the repository
 * headers a compact group's rows sit under.
 *
 * Pure, so it is tested in node; the page draws it.
 */
import {laneKindLabel, type PageLane, type PageRow} from '../../../domain/merge-manager/page';
import {ordinal} from '../../../domain/merge-manager/stage-words';
import {durationText, type LaneTimes, type Timeline, type TimelineFlag} from '../../../domain/merge-manager/times';
import type {GroupCount, StatusGroup, StatusGroupId, StatusItem} from '../../../domain/merge-manager/status';
import {sameRepository} from '../../../domain/project/repo-url';

/** "14:02", in the local time. */
export function clock(at: number): string {
    return new Date(at).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
}

/** "switchboard" for `movelab/switchboard`. */
export function repositoryName(repository: string): string {
    return repository.split('/').pop() ?? repository;
}

/** An expected merge: "~14:52", or "≈14:50" when rough. */
export function expectedClock(time: {readonly at: number; readonly rough: boolean}): string {
    return (time.rough ? '≈' : '~') + clock(time.at);
}

// ── Coming up ──

const FLAG_SIGN: Record<TimelineFlag['tone'], string> = {needsYou: '!', fixing: '↻', held: '‖'};

/** A parked flag's cloth: "! #498" for one, "! 3" for several. */
export function flagText(flag: TimelineFlag): string {
    const what = flag.numbers.length === 1 ? '#' + flag.numbers[0] : String(flag.numbers.length);
    return `${FLAG_SIGN[flag.tone]} ${what}`;
}

/** What sits under a lane's name on Coming up, and the whole of it as a tooltip. */
export interface LaneFacts {
    /** "Switchboard lane · CI ~11 min · clear by ~14:52". */
    readonly line: string;
    /** "updating the head loses its approval"; null where it does not. */
    readonly warning: string | null;
    readonly title: string;
}

export function laneFacts(lane: PageLane | undefined, times: LaneTimes | undefined): LaneFacts {
    const kind = lane ? laneKindLabel(lane.kind) : null;
    const ci = times?.runMs != null ? `CI ~${durationText(times.runMs)}` : null;
    const clear = times?.clearsAt != null ? `clear by ~${clock(times.clearsAt)}` : null;
    const warning = lane?.approvalLostOnPush ? 'updating the head loses its approval' : null;
    const line = [kind, ci, clear].filter((part): part is string => part !== null).join(' · ');
    const title = [
        lane?.repository ?? null,
        kind,
        ci ? ci + ' (the median of its recent green runs)' : null,
        clear,
        warning ? 'A push to a PR here dismisses its approval or needs a new one' : null,
    ]
        .filter((part): part is string => part !== null)
        .join('\n');
    return {line, warning, title};
}

/** "1 ready to land", "2 waiting on review": a lane's not landed counts, lower-case. */
export function countText(count: GroupCount): string {
    const name = count.name.toLowerCase();
    if (count.count === 1 && (count.id === 'drafts' || count.id === 'conflicts')) return `1 ${name.slice(0, -1)}`;
    return `${count.count} ${name}`;
}

/** A time pin under a block's end. */
export interface TimePin {
    readonly key: string;
    readonly at: number;
    readonly text: string;
}

/**
 * The pins under a track's blocks, left to right, each at its block's end;
 * one closer than `minGap` (a fraction of the width) to the last pin kept is
 * left out, so they never write over each other.
 */
export function timePins(
    blocks: readonly {readonly key: string; readonly end: number}[],
    times: LaneTimes | undefined,
    minGap = 0.07,
): TimePin[] {
    const pins: TimePin[] = [];
    for (const block of [...blocks].sort((a, b) => a.end - b.end)) {
        const time = times?.rows.get(block.key);
        if (!time) continue;
        const last = pins[pins.length - 1];
        if (last && block.end - last.at < minGap) continue;
        pins.push({key: block.key, at: block.end, text: expectedClock(time)});
    }
    return pins;
}

/** The parts of Coming up's footer: "3 landed: next ~14:20, all by ~15:40", "2 parked", "+ 4 not landed". */
export interface ComingUpFooter {
    readonly landed: string | null;
    readonly parked: string | null;
    readonly notLanded: string | null;
}

export function comingUpFooter(
    line: Timeline,
    times: ReadonlyMap<string, LaneTimes>,
    notLanded: number,
): ComingUpFooter {
    const timed = [...times.values()].flatMap((lane) => [...lane.rows.values()]);
    const next = timed.length > 0 ? Math.min(...timed.map((time) => time.at)) : null;
    const ends = [...times.values()].map((lane) => lane.clearsAt).filter((at): at is number => at !== null);
    const last = ends.length > 0 ? Math.max(...ends) : null;
    const parked = line.tracks.reduce(
        (sum, track) => sum + track.flags.reduce((n, flag) => n + flag.keys.length, 0),
        0,
    );
    const landed =
        timed.length > 0 && next !== null
            ? `${timed.length} landed: next ~${clock(next)}` +
              (last !== null && last > next ? `, all by ~${clock(last)}` : '')
            : null;
    return {
        landed,
        parked: parked > 0 ? `${parked} parked` : null,
        notLanded: notLanded > 0 ? `+ ${notLanded} not landed` : null,
    };
}

// ── The groups ──

/** A card's kind line: "Landed · queue lane · head", "Landed · Switchboard lane · 2nd", "Not landed". */
export function itemKind(item: StatusItem, lanes: readonly PageLane[]): string {
    if (item.kind === 'notLanded') return 'Not landed';
    const row: PageRow = item.row;
    const lane = lanes.find((candidate) => sameRepository(candidate.repository, row.repository));
    const kind = laneKindLabel(lane?.kind ?? row.lane);
    const lower = kind === 'Queue lane' ? 'queue lane' : kind;
    const where = row.stage.kind === 'head' ? 'head' : row.order !== null ? ordinal(row.order) : null;
    return ['Landed', lower, where].filter((part): part is string => part !== null).join(' · ');
}

/** The folded group the selection is in, which unfolds to show it; null when it is in none. */
export function foldedGroupOf(groups: readonly StatusGroup[], key: string | null): StatusGroupId | null {
    if (!key) return null;
    return groups.find((group) => group.folded && group.items.some((item) => item.key === key))?.id ?? null;
}

/** A repository's rows within a compact group, under its header: "switchboard · Queue lane". */
export interface RepoRows {
    readonly repository: string;
    /** "switchboard". */
    readonly name: string;
    /** "Queue lane", "Switchboard lane"; null for a repository without a lane. */
    readonly lane: string | null;
    readonly items: readonly StatusItem[];
}

/** A group's items by repository, each repository where its first item stands, its items in their order. */
export function byRepository(items: readonly StatusItem[], lanes: readonly PageLane[]): RepoRows[] {
    const order: string[] = [];
    const rows = new Map<string, StatusItem[]>();
    for (const item of items) {
        const repository = item.kind === 'lane' ? item.row.repository : item.pr.repository;
        const list = rows.get(repository);
        if (list) list.push(item);
        else {
            order.push(repository);
            rows.set(repository, [item]);
        }
    }
    return order.map((repository) => {
        const lane = lanes.find((candidate) => sameRepository(candidate.repository, repository));
        return {
            repository,
            name: repositoryName(repository),
            lane: lane ? laneKindLabel(lane.kind) : null,
            items: rows.get(repository) ?? [],
        };
    });
}
