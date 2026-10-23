/**
 * The row's snooze menu: the times `snoozeOptions` offers right now, and Wake
 * once the session is snoozed.
 *
 * It hangs below the moon in a portal on the body, out of the row's clipped,
 * fading action strip, and goes on a choice, Escape, a click elsewhere or a
 * scroll of the list.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { snoozeOptions } from '../../../domain/session/snooze';
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface SnoozeMenuProps {
  /** The moon it hangs from. */
  anchor: HTMLElement;
  /** The ISO time the session is snoozed until, if it is. */
  snoozedUntil: string | null;
  /** A time to snooze until, or null to wake. */
  onPick(until: Date | null): void;
  onClose(): void;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "15:00" today, "Wed 08:00" on another day. */
export function snoozeTime(until: Date, now: Date): string {
  const time = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`;
  return until.toDateString() === now.toDateString() ? time : `${DAYS[until.getDay()]} ${time}`;
}

export function SnoozeMenu({ anchor, snoozedUntil, onPick, onClose }: SnoozeMenuProps): JSX.Element {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null);
  // Read when it opens, so only times still ahead are offered.
  const [now] = useState(() => new Date());
  const options = snoozeOptions(now);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    setPlace({ top: r.bottom + 4, right: window.innerWidth - r.right });
  }, [anchor]);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [anchor, onClose]);

  /** Arrow keys move between the entries. */
  const step = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const item = (key: string, label: string, meta: string, until: Date | null): JSX.Element => (
    <button
      key={key}
      role="menuitem"
      className="snooze-menu-item"
      onClick={(e) => {
        e.stopPropagation();
        onPick(until);
      }}
    >
      <span>{label}</span>
      <small>{meta}</small>
    </button>
  );

  return createPortal(
    <div
      ref={menu}
      className="snooze-menu"
      role="menu"
      aria-label="Snooze until"
      style={place ? { top: place.top, right: place.right } : { visibility: 'hidden' }}
      onKeyDown={step}
      onClick={e => e.stopPropagation()}
    >
      {snoozedUntil && item('wake', 'Wake', 'back in the list now', null)}
      {options.map(o => item(o.label, o.label, snoozeTime(o.until, now), o.until))}
    </div>,
    document.body,
  );
}
