import { test } from 'node:test';
import assert from 'node:assert/strict';

import { advance, setReducedMotion, Spring } from '../src/renderer/lib/motion/spring';

// Step the loop by hand, as the frame loop would, until the spring rests or the budget runs out.
function settle(spring: Spring, seconds = 3): number {
  let t = 0;
  while (spring.moving && t < seconds) {
    advance(1 / 60);
    t += 1 / 60;
  }
  return t;
}

// Push a spring from 0 to 100 and report the furthest it got.
function peakOnTheWayTo100(): number {
  const spring = new Spring(0);
  let peak = 0;
  spring.onUpdate = (x) => { peak = Math.max(peak, x); };
  spring.to(100);
  settle(spring);
  return peak;
}

test('a spring comes to rest exactly on its target', () => {
  /* Given */
  setReducedMotion(false);
  const spring = new Spring(0);

  /* When */
  spring.to(100);
  settle(spring);

  /* Then */
  assert.equal(spring.moving, false);
  assert.equal(spring.x, 100);
  assert.equal(spring.v, 0);
});

test('the house feel overshoots a little', () => {
  // Lively (damping 0.78) passes its target before settling.
  /* Given */
  setReducedMotion(false);

  /* When */
  const peak = peakOnTheWayTo100();

  /* Then */
  assert.equal(peak > 100.5, true, `reduced=false peak=${peak}`);
});

test('reduced motion does not overshoot', () => {
  // Critically damped never passes its target.
  /* Given */
  setReducedMotion(true);

  try {
    /* When */
    const peak = peakOnTheWayTo100();

    /* Then */
    assert.equal(peak > 100.5, false, `reduced=true peak=${peak}`);
  } finally {
    setReducedMotion(false);
  }
});

test('retargeting mid-flight keeps the velocity', () => {
  /* Given */
  setReducedMotion(false);
  const spring = new Spring(0);
  spring.to(100);
  advance(0.05);
  const velocity = spring.v;

  /* When */
  spring.to(-100);

  /* Then */
  assert.equal(spring.v, velocity);
});

test('a kick springs back to where it was', () => {
  /* Given */
  setReducedMotion(false);
  const spring = new Spring(1, { eps: 0.0005 });

  /* When */
  spring.to(1).kick(9);
  settle(spring);

  /* Then */
  assert.equal(spring.x, 1);
});

test('under reduced motion a kick does nothing', () => {
  /* Given */
  setReducedMotion(true);
  const spring = new Spring(1);

  try {
    /* When */
    spring.kick(9);

    /* Then */
    assert.equal(spring.v, 0);
  } finally {
    setReducedMotion(false);
  }
});
