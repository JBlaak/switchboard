/**
 * A QR code as one SVG path, encoded here from the text (`domain/qr`).
 *
 * Dark on white whatever the theme, with the four-module quiet zone the
 * standard asks for, and crisp edges so a phone camera reads it from across
 * a desk.
 */
import { useMemo } from 'react';
import { encodeQr } from '../../../domain/qr/qr-code';
import type { JSX } from 'react';

const QUIET = 4;

export function QrImage({ text, label }: { text: string; label: string }): JSX.Element {
  const { size, path } = useMemo(() => {
    const qr = encodeQr(text);
    let d = '';
    qr.modules.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    }));
    return { size: qr.size + QUIET * 2, path: d };
  }, [text]);
  return (
    <svg className="pa-qr" role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#141517" />
    </svg>
  );
}
