/**
 * The row's inline SVGs, as the vanilla list drew them.
 *
 * Strings, set as HTML where they are used, rather than JSX: they are the
 * exact markup the screenshots were taken of, and the icons shared with
 * vanilla code (`lib/icons`) are strings already.
 */
import { ICONS } from '../../lib/icons';

const SVG = {
  pinFilled: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>',
  pinOutline: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>',
  stop: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>',
  terminal: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
} as const;

/** `dangerouslySetInnerHTML` values, made once. */
export const HTML = {
  pinFilled: { __html: SVG.pinFilled },
  pinOutline: { __html: SVG.pinOutline },
  stop: { __html: SVG.stop },
  terminal: { __html: SVG.terminal },
  archive16: { __html: ICONS.archive(16) },
  archive14: { __html: ICONS.archive(14) },
  launchConfig: { __html: ICONS.launchConfig(14) },
  /** `&#9654;`, the group's disclosure arrow. */
  arrow: { __html: '<span class="arrow">&#9654;</span>' },
} as const;

/** The agents badge's inside: the robot, then the count. */
export function agentsBadgeHtml(count: number): { __html: string } {
  return { __html: ICONS.agents(11) + '<span class="session-agents-count">' + count + '</span>' };
}
