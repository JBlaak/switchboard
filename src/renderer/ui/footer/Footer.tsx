/**
 * The strip pinned under the session list: the update notice, the status line
 * and the quota gauges, top to bottom.
 *
 * Portalled into `#sidebar-footer` (see `Root`), whose styles lay these out.
 */
import { QuotaGauges } from './QuotaGauges';
import { StatusLine } from './StatusLine';
import { UpdateNotice } from './UpdateNotice';
import type { JSX } from 'react';

export function Footer(): JSX.Element {
  return (
    <>
      <UpdateNotice />
      <StatusLine />
      <QuotaGauges />
    </>
  );
}
