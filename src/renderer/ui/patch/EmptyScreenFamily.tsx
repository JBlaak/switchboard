/**
 * The Patch family on the empty screen: one Patch per running session, out on
 * an adventure somewhere, with the session's subagents as little helpers.
 *
 * Where they are follows the part of the day at the user's location (the
 * weather's sunrise and sunset) and the season, and changes a few times a day
 * like a new outing rather than on every appearance (`domain/companion/adventure`).
 * When the place changes, everyone walks in from the side.
 *
 * While the empty screen shows, the scene follows the sessions: a session that
 * starts working or asks for the user changes pose straight away. Clicking a
 * member opens its session. It holds still while the window is in the
 * background. Like Patch, the scene is the package's imperative
 * handle mounted from an effect.
 *
 * Under the scene the card has a floor for Patch to stand on, so Patch, in
 * front of the card, never covers a member of the outing.
 */
import {useEffect, useRef} from 'react';
import {mountFamily} from '@jblaak/patch';
import '@jblaak/patch/family.css';
import {adventureAt} from '../../../domain/companion/adventure';
import {dressingOn} from '../../../domain/companion/calendar';
import {fetchWeather} from '../../app/weather';
import {getState, onEvent, store} from '../../state/app-store';
import {familyMembersIn} from '../../state/family-members';
import {sessionMap} from '../../state/session-store';
import {openRow} from '../session-list/actions';
import type {JSX} from 'react';
import type {FamilyHandle} from '@jblaak/patch';
import type {Adventure, SunTimes} from '../../../domain/companion/adventure';
import type {Sky} from '../../../domain/weather/weather';

/** How long an appearance waits for the weather before going with what it has. */
const WEATHER_TIMEOUT_MS = 1500;

/** How often a visible scene checks whether the part of the day has turned. */
const TICK_MS = 60_000;

function sameDay(epoch: number, now: Date): boolean {
    return new Date(epoch).toDateString() === now.toDateString();
}

/** The place last walked into, across appearances, so a return visit does not walk in again. */
let lastPlace: string | null = null;

export function EmptyScreenFamily(): JSX.Element {
    const frame = useRef<HTMLDivElement>(null);
    const stage = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const card = frame.current!;
        const placeholder = card.parentElement!;
        const visible = (): boolean => placeholder.style.display !== 'none';

        const family: FamilyHandle = mountFamily(stage.current!, {
            onSelect: (sessionId) => openRow(sessionId, sessionId),
        });

        let adventure: Adventure | null = null;
        let sky: Sky | null = null;
        let sun: SunTimes | null = null;
        let shown = '';
        let latest = 0;

        /** Draw the scene, unless nothing it shows has changed. */
        const draw = (arriving: boolean): void => {
            if (!adventure) return;
            const members = familyMembersIn(getState(), sessionMap.values());
            const signature = `${adventure.key}|${sky}|${JSON.stringify(members)}`;
            if (!arriving && signature === shown) return;
            shown = signature;
            card.dataset.place = adventure.place;
            family.show({
                place: adventure.place,
                time: adventure.time,
                members,
                weather: sky === 'rain' || sky === 'snow' ? sky : null,
                arriving,
            });
        };

        /** Work out where the family is now, and walk in if that is somewhere new. */
        const appear = async (): Promise<void> => {
            const token = ++latest;
            const weather = await Promise.race([
                fetchWeather(),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), WEATHER_TIMEOUT_MS)),
            ]);
            if (token !== latest || !visible()) return;
            sky = weather?.sky ?? null;
            const now = new Date();
            // Yesterday's sunrise says nothing about this morning: go by the clock until the forecast catches up.
            sun =
                weather?.sunrise != null && weather.sunset != null && sameDay(weather.sunrise, now)
                    ? {sunrise: weather.sunrise, sunset: weather.sunset}
                    : null;
            adventure = adventureAt(now, sun, dressingOn(now).season, sky);
            const arriving = adventure.place !== lastPlace;
            lastPlace = adventure.place;
            draw(arriving);
        };

        // Hold the scene still while the window is in the background: nobody is watching, and it saves the battery.
        const syncPause = (): void => family.pause(document.hidden || !document.hasFocus());
        syncPause();
        window.addEventListener('focus', syncPause);
        window.addEventListener('blur', syncPause);
        document.addEventListener('visibilitychange', syncPause);

        if (visible()) void appear();
        const unsubscribers = [
            onEvent('emptyScreenShown', () => void appear()),
            // Follow the sessions while the scene shows; `draw` skips events that change nothing it draws.
            store.subscribe(() => {
                if (visible()) draw(false);
            }),
        ];
        const tick = setInterval(() => {
            if (!visible() || !adventure) return;
            const now = new Date();
            // The part of the day turned: ask the weather again and set out for the next place.
            if (adventureAt(now, sun, dressingOn(now).season, sky).key !== adventure.key) void appear();
        }, TICK_MS);

        return () => {
            window.removeEventListener('focus', syncPause);
            window.removeEventListener('blur', syncPause);
            document.removeEventListener('visibilitychange', syncPause);
            clearInterval(tick);
            unsubscribers.forEach((unsubscribe) => unsubscribe());
            family.destroy();
        };
    }, []);

    return (
        <div ref={frame} className="placeholder-family" data-testid="patch-family">
            <div ref={stage} className="placeholder-family-scene" />
            <div className="placeholder-family-floor" />
        </div>
    );
}
