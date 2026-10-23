/** The phone, drawn the same way wherever Phone access shows (#194). */
import type { JSX } from 'react';

export function PhoneIcon({ size = 14, strokeWidth = 2 }: { size?: number; strokeWidth?: number }): JSX.Element {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </svg>
  );
}
