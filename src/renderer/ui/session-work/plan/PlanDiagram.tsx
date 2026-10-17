/**
 * The flow diagram (D1–D3, P5, P6): level bands with their labels, a box per
 * issue, ghosts of outside blockers above their issue, and an arrow from each
 * blocker to what it blocks — solid once the blocker is closed, dashed while
 * it is open. Hovering an issue lights up its chain and fades the rest; a
 * click selects it.
 *
 * Every position comes from `planGeometry`; this only paints.
 */
import { useMemo } from 'react';
import type { JSX } from 'react';
import { issueKeyString, sameIssue } from '../../../../domain/plan/model';
import type { IssueKey, NodeState, Plan, PlanLayout } from '../../../../domain/plan/model';
import { arrowInChain, chainOf, inChain, NODE_H, NODE_W, PAD, GHOST_H, planGeometry } from './geometry';
import { issueIn, issueUrl, levelStatus, nodeMiniLine, shortRef, STATE_LABEL } from './describe';
import type { IssueActions, PlanHandlers, PlanUi } from './types';

export function PlanDiagram(
  { plan, layout, ui, on, issueActions }:
  { plan: Plan; layout: PlanLayout; ui: PlanUi; on: PlanHandlers; issueActions?: IssueActions },
): JSX.Element {
  const geometry = useMemo(() => planGeometry(plan, layout), [plan, layout]);
  const focus = ui.hovered ?? ui.selected;
  const chain = useMemo(() => (focus ? chainOf(plan, layout, focus) : null), [plan, layout, focus]);
  // Lit arrows go on top of the faded ones.
  const arrows = chain
    ? [...geometry.arrows].sort((a, b) => Number(arrowInChain(chain, a)) - Number(arrowInChain(chain, b)))
    : geometry.arrows;

  return (
    <div
      className={'pv-diagram' + (chain ? ' is-tracing' : '')}
      style={{ width: geometry.width, height: geometry.height }}
      data-testid="plan-diagram"
    >
      {geometry.bands.map((band) => {
        const status = levelStatus(plan, layout, band.level);
        return (
          <div
            key={band.level}
            className={'pv-band is-' + status.kind}
            style={{ top: band.top, left: PAD, width: geometry.width - 2 * PAD, height: band.height }}
          >
            <div className="pv-band-label" aria-label={`Level ${band.level}, ${status.label}`}>
              <span className="pv-band-cap">Level</span>
              <span className="pv-band-num">{band.level}</span>
              <span className="pv-band-status">{status.label}</span>
              <span className="pv-band-count">{status.closed + ' / ' + status.total + ' closed'}</span>
            </div>
          </div>
        );
      })}

      <svg className="pv-arrows" width={geometry.width} height={geometry.height} aria-hidden="true">
        {arrows.map((arrow) => {
          const lit = arrowInChain(chain, arrow);
          const cls = 'pv-arrow' + (arrow.waiting ? ' is-waiting' : '') + (lit ? ' is-lit' : '');
          return (
            <g key={issueKeyString(arrow.from) + '>' + issueKeyString(arrow.to)} className={cls}>
              <path className="pv-arrow-line" d={arrow.d} />
              <path className="pv-arrow-head" d={arrow.head} />
            </g>
          );
        })}
      </svg>

      {geometry.ghosts.map((ghost) => {
        const state = layout.stateOf(ghost.issue);
        return (
          <button
            key={issueKeyString(ghost.issue) + '>' + issueKeyString(ghost.blocks)}
            type="button"
            className={'pv-ghost is-' + state + (inChain(chain, ghost.blocks) ? '' : ' is-faded')}
            style={{ left: ghost.x, top: ghost.y, width: ghost.w, height: GHOST_H }}
            title={`${shortRef(plan, ghost.issue)} ${ghost.issue.title} · ${STATE_LABEL[state]} · outside this plan`}
            aria-label={`${shortRef(plan, ghost.issue)} ${ghost.issue.title}, ${STATE_LABEL[state]}, outside this plan`}
            onClick={() => on.open(issueUrl(ghost.issue))}
          >
            <span className="pv-dot" aria-hidden="true" />
            <span className="pv-ghost-ref">{ghostRef(plan, ghost.issue)}</span>
          </button>
        );
      })}

      {geometry.nodes.map((box) => {
        const issue = issueIn(plan, box.issue)!;
        const state = layout.stateOf(issue);
        const selected = !!ui.selected && sameIssue(ui.selected, issue);
        const session = issueActions?.sessionFor?.(issue) ?? null;
        const cls = 'pv-node is-' + state + (selected ? ' is-selected' : '') + (inChain(chain, issue) ? '' : ' is-faded');
        return (
          <button
            key={issueKeyString(issue)}
            type="button"
            className={cls}
            style={{ left: box.x, top: box.y, width: NODE_W, height: NODE_H }}
            data-plan-issue={issueKeyString(issue)}
            aria-label={`#${issue.number} ${issue.title}, ${STATE_LABEL[state]}`}
            aria-pressed={selected}
            onMouseEnter={() => on.hover(issue)}
            onMouseLeave={() => on.hover(null)}
            onClick={() => on.select(selected ? null : issue)}
          >
            <span className="pv-node-top">
              <StateIcon state={state} />
              <span className="pv-num">{'#' + issue.number}</span>
              <span className="pv-node-gap" />
              <span className="pv-node-state">{STATE_LABEL[state]}</span>
            </span>
            <span className="pv-node-title">{issue.title}</span>
            {session
              ? (
                <span className={'pv-node-mini is-session' + (session.working ? ' is-working' : '')}>
                  {'Session ' + session.name + ' · ' + (session.working ? 'working' : 'idle')}
                </span>
              )
              : <span className="pv-node-mini">{nodeMiniLine(plan, issue)}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function StateIcon({ state }: { state: NodeState }): JSX.Element {
  if (state === 'merged' || state === 'closed' || state === 'not-planned') {
    return (
      <svg className="pv-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        {state === 'not-planned' ? <path d="M4 4l8 8M12 4l-8 8" /> : <path d="M3 8.5 6.5 12 13 4.5" />}
      </svg>
    );
  }
  if (state === 'locked') {
    return (
      <svg className="pv-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
      </svg>
    );
  }
  return (
    <svg className="pv-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" strokeWidth="1.6" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" />
    </svg>
  );
}

/** The key under the diagram. */
export function PlanLegend(): JSX.Element {
  const states: NodeState[] = ['merged', 'review', 'draft', 'ready', 'locked'];
  return (
    <div className="pv-legend">
      {states.map(state => (
        <span key={state} className={'pv-legend-item is-' + state}>
          <span className="pv-dot" aria-hidden="true" />
          {state === 'ready' ? 'Ready to start' : STATE_LABEL[state]}
        </span>
      ))}
      <span>Solid arrow: blocker done · dashed: still waiting</span>
      <span className="pv-legend-gap" />
      <span>Hover an issue to trace its chain · click to see it</span>
    </div>
  );
}

/** A ghost's short label: `#7`, or `repo#7` without the owner, which the title gives in full. */
function ghostRef(plan: Plan, issue: IssueKey): string {
  return issue.repository === plan.repository ? '#' + issue.number : issue.repository.split('/').pop() + '#' + issue.number;
}
