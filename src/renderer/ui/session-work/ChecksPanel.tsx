/**
 * A PR's checks, under its activity card: each one with its state, and the
 * end of a failing one's log, so what broke can be read without leaving the
 * page (or knowing which job to open on GitHub).
 */
import { useEffect } from 'react';
import type { JSX } from 'react';
import { useStore } from '../use-store';
import { loadCheckLog } from './check-log';
import type { CheckRun, SessionWorkItem } from '../../../domain/session-work/model';

const STATE_LABEL: Record<CheckRun['state'], string> = {
  passing: 'Passing',
  failing: 'Failing',
  pending: 'Running',
  skipped: 'Skipped',
};

export function ChecksPanel({ item }: { item: SessionWorkItem }): JSX.Element | null {
  if (item.kind !== 'pr' || !item.pr.checks?.length) return null;
  const { pr } = item;
  const checks = pr.checks ?? [];
  return (
    <section className="sw-checks" aria-label="Checks">
      <h3 className="sw-checks-title">Checks</h3>
      <ul className="sw-check-list">
        {checks.map((check, i) => (
          <li key={check.name + '\0' + i} className="sw-check" data-state={check.state}>
            <span className={'sw-check-dot is-' + check.state} aria-hidden="true" />
            <span className="sw-check-name">{check.name}</span>
            <span className="sw-check-state">{STATE_LABEL[check.state]}</span>
            {check.state === 'failing' && check.url && <CheckLogTail repository={pr.repository} url={check.url} name={check.name} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CheckLogTail({ repository, url, name }: { repository: string; url: string; name: string }): JSX.Element {
  const log = useStore(state => state.ciStatus.checkLogs[url]);
  useEffect(() => {
    if (repository) loadCheckLog(repository, url);
  }, [repository, url]);

  let body: string;
  if (!log || log.loading) body = 'Reading the log…';
  else body = log.text ?? 'No log to show. Open the check on GitHub to read it.';
  return (
    <pre className="sw-check-log" aria-label={'Log of ' + name} data-loading={!log || log.loading ? 'true' : undefined}>
      {body}
    </pre>
  );
}
