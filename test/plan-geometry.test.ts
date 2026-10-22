import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layOutPlan } from '../src/domain/plan/layout';
import { issueKeyString } from '../src/domain/plan/model';
import {
  arrowInChain, BAND_PAD, chainOf, inChain, LEVEL_PITCH, NODE_H, NODE_W, PAD, planGeometry, spread,
} from '../src/renderer/ui/session-work/plan/geometry';
import { diamond, issue, key, needs, plan } from './support/plans';

function geometryOf(p = diamond()) {
  return { p, layout: layOutPlan(p), geometry: planGeometry(p, layOutPlan(p)) };
}

function boxOf(geometry: ReturnType<typeof planGeometry>, number: number) {
  return geometry.nodes.find(node => node.issue.number === number)!;
}

test('levels sit one pitch apart, and no two nodes overlap', () => {
  /* When */
  const { geometry } = geometryOf();

  /* Then */
  assert.equal(boxOf(geometry, 11).y - boxOf(geometry, 10).y, LEVEL_PITCH);
  assert.equal(boxOf(geometry, 13).y - boxOf(geometry, 11).y, LEVEL_PITCH);
  for (const a of geometry.nodes) {
    for (const b of geometry.nodes) {
      if (a === b) continue;
      const apart = a.x + NODE_W <= b.x || b.x + NODE_W <= a.x || a.y + NODE_H <= b.y || b.y + NODE_H <= a.y;
      assert.ok(apart, `#${a.issue.number} overlaps #${b.issue.number}`);
    }
  }
});

test('every node fits inside the drawing', () => {
  /* When */
  const { geometry } = geometryOf();

  /* Then */
  for (const node of geometry.nodes) {
    assert.ok(node.x >= 0 && node.x + NODE_W <= geometry.width);
    assert.ok(node.y >= 0 && node.y + NODE_H <= geometry.height);
  }
});

test('a band leaves as much room right of its widest row as above and below it', () => {
  /* When */
  const { geometry } = geometryOf();

  /* Then */
  const bandRight = geometry.width - PAD;
  const rightmost = Math.max(...geometry.nodes.map(node => node.x + NODE_W));
  assert.equal(bandRight - rightmost, BAND_PAD);
});

test('an arrow leaves the blocker’s bottom edge and ends on the dependent’s top edge', () => {
  /* When */
  const { geometry } = geometryOf();

  /* Then */
  for (const arrow of geometry.arrows) {
    const from = boxOf(geometry, arrow.from.number);
    const to = boxOf(geometry, arrow.to.number);
    assert.equal(arrow.start.y, from.y + NODE_H);
    assert.ok(arrow.start.x > from.x && arrow.start.x < from.x + NODE_W);
    assert.equal(arrow.end.y, to.y);
    assert.ok(arrow.end.x > to.x && arrow.end.x < to.x + NODE_W);
  }
});

test('a blocker with two dependents fans out from two anchors, left one to the left', () => {
  /* When */
  const { geometry } = geometryOf();

  /* Then */
  const fromTen = geometry.arrows.filter(arrow => arrow.from.number === 10).sort((a, b) => a.start.x - b.start.x);
  assert.equal(fromTen.length, 2);
  assert.ok(fromTen[0].start.x < fromTen[1].start.x);
  assert.ok(boxOf(geometry, fromTen[0].to.number).x < boxOf(geometry, fromTen[1].to.number).x);
});

test('an arrow is dashed while its blocker is open, solid once it is closed (D1)', () => {
  /* When */
  const { geometry } = geometryOf();

  /* Then */
  const waiting = Object.fromEntries(geometry.arrows.map(arrow => [`${arrow.from.number}>${arrow.to.number}`, arrow.waiting]));
  assert.deepEqual(waiting, { '10>11': false, '10>12': false, '11>13': true, '12>13': true });
});

test('anchors spread over the middle of the edge, one alone in the middle', () => {
  /* When */
  const alone = spread(0, 1);
  const pair = [spread(0, 2), spread(1, 2)];
  const outer = spread(0, 3);

  /* Then */
  assert.equal(alone, 0);
  assert.equal(pair[0], -pair[1]);
  assert.ok(Math.abs(outer) < NODE_W * 0.3 + 1);
});

test('hovering an issue lights exactly its ancestors and descendants (D3)', () => {
  /* Given */
  const { p, layout } = geometryOf();

  /* When */
  const chain = chainOf(p, layout, key(11));

  /* Then */
  const lit = p.issues.filter(i => inChain(chain, i)).map(i => i.number);
  assert.deepEqual(lit, [10, 11, 13]);
});

test('an arrow is lit only when both its ends are on one side of the focus', () => {
  /* Given */
  const { p, layout } = geometryOf();
  const chain = chainOf(p, layout, key(11));

  /* When */
  const lit = [[10, 11], [11, 13], [10, 12], [12, 13]].map(([from, to]) => arrowInChain(chain, { from: key(from), to: key(to) }));
  const unfocused = arrowInChain(null, { from: key(10), to: key(11) });

  /* Then */
  assert.deepEqual(lit, [true, true, false, false]);
  assert.equal(unfocused, false);
});

test('an outside blocker is a ghost above its issue, with room made for it (P5)', () => {
  /* Given */
  const outside = { ...issue(5, { title: 'Elsewhere' }), repository: 'acme/other' };
  const p = plan([issue(1), needs(2, [1], { blockedBy: [key(1), key(5, 'acme/other')] })], { outside: [outside] });

  /* When */
  const geometry = planGeometry(p, layOutPlan(p));

  /* Then */
  const [ghost] = geometry.ghosts;
  const target = boxOf(geometry, 2);
  assert.equal(issueKeyString(ghost.issue), 'acme/other#5');
  assert.ok(ghost.y < target.y && ghost.x >= target.x && ghost.x + ghost.w <= target.x + NODE_W);
  assert.ok(target.y - boxOf(geometry, 1).y > LEVEL_PITCH);
  assert.ok(ghost.y > boxOf(geometry, 1).y + NODE_H);
});
