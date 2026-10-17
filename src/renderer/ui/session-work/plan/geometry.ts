/**
 * Where the flow diagram draws everything (D1, P5): the level bands, a box per
 * issue, the ghosts of outside blockers above their issue, and a curved arrow
 * from each blocker to each issue it blocks. Pure, so the numbers are tested
 * in node; `PlanDiagram` only paints them.
 *
 * Rows come from `layOutPlan` in drawing order and are centred on the widest
 * one. An arrow leaves the blocker's bottom edge and enters the dependent's
 * top edge at anchors spread across the middle 60% of each edge: a blocker
 * with three dependents fans out from three points, a dependent with two
 * blockers takes them in at two, both ordered left to right so arrows from
 * one node do not cross each other. Outside blockers come last, as ghosts
 * over the right of their issue.
 */
import { issueKeyString, sameIssue } from '../../../../domain/plan/model';
import type { IssueKey, Plan, PlanIssue, PlanLayout } from '../../../../domain/plan/model';

export const NODE_W = 188;
export const NODE_H = 96;
/** Between two nodes in a row. */
export const NODE_GAP = 20;
/** From one row's top to the next one's. */
export const LEVEL_PITCH = 176;
/** The column the level labels sit in. */
export const LABEL_W = 120;
/** Padding round the whole drawing. */
export const PAD = 24;
/** How far a band reaches above and below its nodes. */
export const BAND_PAD = 14;
export const GHOST_H = 24;
export const GHOST_W = 88;
/** The extra room above a row that has ghosts. */
export const GHOST_SPACE = 40;
/** The share of a node's edge the arrow anchors spread over. */
const SPREAD = 0.6;
/** The arrow head's height. */
const HEAD = 7;

export interface NodeBox {
  readonly issue: IssueKey;
  readonly x: number;
  readonly y: number;
}

export interface GhostBox {
  readonly issue: PlanIssue;
  /** The plan issue it blocks. */
  readonly blocks: IssueKey;
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

export interface Arrow {
  readonly from: IssueKey;
  readonly to: IssueKey;
  /** The curve's SVG path, from the blocker's bottom to just above the dependent's top. */
  readonly d: string;
  /** The head's SVG path, its tip on the dependent's top edge. */
  readonly head: string;
  /** The blocker is still open: drawn dashed (D1). */
  readonly waiting: boolean;
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface Band {
  /** 1-based. */
  readonly level: number;
  readonly top: number;
  readonly height: number;
  /** Where its nodes start. */
  readonly nodeTop: number;
}

export interface PlanGeometry {
  readonly width: number;
  readonly height: number;
  readonly bands: readonly Band[];
  readonly nodes: readonly NodeBox[];
  readonly ghosts: readonly GhostBox[];
  /** Ghost → its issue first, then blocker → dependent. */
  readonly arrows: readonly Arrow[];
}

/** The plan issues an issue waits on, once each and never itself. */
export function blockersInPlan(plan: Plan, issue: IssueKey): IssueKey[] {
  const own = plan.issues.find(other => sameIssue(other, issue));
  if (!own) return [];
  const seen = new Set<string>();
  const found: IssueKey[] = [];
  for (const blocker of own.blockedBy) {
    const key = issueKeyString(blocker);
    if (seen.has(key) || sameIssue(blocker, issue)) continue;
    if (!plan.issues.some(other => sameIssue(other, blocker))) continue;
    seen.add(key);
    found.push({ repository: blocker.repository, number: blocker.number });
  }
  return found;
}

export function planGeometry(plan: Plan, layout: PlanLayout): PlanGeometry {
  const widest = layout.levels.reduce((max, row) => Math.max(max, row.length), 0);
  const area = Math.max(0, widest * NODE_W + (widest - 1) * NODE_GAP);
  const left = PAD + LABEL_W;

  const bands: Band[] = [];
  const nodes: NodeBox[] = [];
  const ghosts: GhostBox[] = [];
  const at = new Map<string, NodeBox>();
  let y = PAD + BAND_PAD;
  layout.levels.forEach((row, i) => {
    const hasGhosts = row.some(issue => layout.ghosts(issue).length > 0);
    if (i > 0) y += LEVEL_PITCH;
    if (hasGhosts) y += GHOST_SPACE;
    const rowWidth = row.length * NODE_W + (row.length - 1) * NODE_GAP;
    const x0 = left + Math.round((area - rowWidth) / 2);
    row.forEach((issue, column) => {
      const box = { issue, x: x0 + column * (NODE_W + NODE_GAP), y };
      nodes.push(box);
      at.set(issueKeyString(issue), box);
      // Ghosts sit over the right of the node, so the arrows from the row
      // above, which take the left anchors (see below), pass beside them.
      const outside = layout.ghosts(issue);
      if (outside.length) {
        const gap = 6;
        const w = Math.min(GHOST_W, Math.floor((NODE_W - (outside.length - 1) * gap) / outside.length));
        const total = outside.length * w + (outside.length - 1) * gap;
        const gx = box.x + NODE_W - total;
        outside.forEach((ghost, k) => {
          ghosts.push({ issue: ghost, blocks: issue, x: gx + k * (w + gap), y: y - BAND_PAD - GHOST_H - 10, w });
        });
      }
    });
    bands.push({ level: i + 1, top: y - BAND_PAD, height: NODE_H + 2 * BAND_PAD, nodeTop: y });
  });
  const height = bands.length ? y + NODE_H + BAND_PAD + PAD : 0;
  const width = left + area + PAD;

  const isOpen = (issue: IssueKey): boolean =>
    [...plan.issues, ...plan.outside].find(other => sameIssue(other, issue))?.state !== 'closed';

  const arrows: Arrow[] = [];
  for (const ghost of ghosts) {
    const x = ghost.x + ghost.w / 2;
    const target = at.get(issueKeyString(ghost.blocks))!;
    arrows.push(arrow(ghost.issue, ghost.blocks, { x, y: ghost.y + GHOST_H }, { x, y: target.y }, isOpen(ghost.issue)));
  }
  for (const box of nodes) {
    const parents = blockersInPlan(plan, box.issue)
      .filter(parent => at.has(issueKeyString(parent)))
      .sort((a, b) => at.get(issueKeyString(a))!.x - at.get(issueKeyString(b))!.x);
    parents.forEach((parent, j) => {
      const from = at.get(issueKeyString(parent))!;
      const kids = layout.unlocks(parent)
        .filter(kid => at.has(issueKeyString(kid)))
        .sort((a, b) => at.get(issueKeyString(a))!.x - at.get(issueKeyString(b))!.x);
      const i = kids.findIndex(kid => sameIssue(kid, box.issue));
      const start = { x: from.x + NODE_W / 2 + spread(i, kids.length), y: from.y + NODE_H };
      // Ghosts take the right-hand anchors: the plan's own arrows land left of them.
      const slots = parents.length + layout.ghosts(box.issue).length;
      const end = { x: box.x + NODE_W / 2 + spread(j, slots), y: box.y };
      arrows.push(arrow(parent, box.issue, start, end, isOpen(parent)));
    });
  }

  return { width, height, bands, nodes, ghosts, arrows };
}

/** The offset of the `index`th of `count` anchors from the middle of a node's edge. */
export function spread(index: number, count: number): number {
  if (count <= 1 || index < 0) return 0;
  return Math.round(((index + 1) / (count + 1) - 0.5) * NODE_W * SPREAD);
}

function arrow(
  from: IssueKey, to: IssueKey, start: { x: number; y: number }, tip: { x: number; y: number }, waiting: boolean,
): Arrow {
  const x1 = start.x, y1 = start.y;
  const x2 = tip.x, y2 = tip.y - 1 - HEAD;
  const bend = Math.max(0, Math.min(64, (y2 - y1) / 2));
  return {
    from: { repository: from.repository, number: from.number },
    to,
    d: `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`,
    head: `M ${x2 - 4.5} ${y2} L ${x2 + 4.5} ${y2} L ${x2} ${tip.y - 1} Z`,
    waiting,
    start,
    end: tip,
  };
}

// ── The hover chain (D3) ──

export interface Chain {
  /** The issue itself, and everything it needs, transitively. */
  readonly up: ReadonlySet<string>;
  /** The issue itself, and everything it unlocks, transitively. */
  readonly down: ReadonlySet<string>;
}

/** Everything `focus` needs and everything it unlocks, by `issueKeyString`; the issue itself is in both. */
export function chainOf(plan: Plan, layout: PlanLayout, focus: IssueKey): Chain {
  const walk = (next: (issue: IssueKey) => IssueKey[]): Set<string> => {
    const seen = new Set<string>([issueKeyString(focus)]);
    const stack = [...next(focus)];
    while (stack.length) {
      const issue = stack.pop()!;
      const key = issueKeyString(issue);
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push(...next(issue));
    }
    return seen;
  };
  return {
    up: walk(issue => blockersInPlan(plan, issue)),
    down: walk(issue => layout.unlocks(issue)),
  };
}

/** Whether an issue lights up for a chain: on it, or nothing is in focus. */
export function inChain(chain: Chain | null, issue: IssueKey): boolean {
  if (!chain) return true;
  const key = issueKeyString(issue);
  return chain.up.has(key) || chain.down.has(key);
}

/** Whether an arrow is part of a chain: both its ends on the same side of the focus. */
export function arrowInChain(chain: Chain | null, arrow: Pick<Arrow, 'from' | 'to'>): boolean {
  if (!chain) return false;
  const from = issueKeyString(arrow.from);
  const to = issueKeyString(arrow.to);
  return (chain.up.has(from) && chain.up.has(to)) || (chain.down.has(from) && chain.down.has(to));
}
