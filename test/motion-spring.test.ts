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

test('a spring comes to rest exactly on its target', () => {
  setReducedMotion(false);
  const spring = new Spring(0);

  spring.to(100);
  settle(spring);

  assert.equal(spring.moving, false);
  assert.equal(spring.x, 100);
  assert.equal(spring.v, 0);
});

test('the house feel overshoots a little; reduced motion does not', () => {
  // Lively (damping 0.78) passes its target before settling; critically damped never does.
  for (const [reduced, overshoots] of [[false, true], [true, false]] as const) {
    setReducedMotion(reduced);
    const spring = new Spring(0);
    let peak = 0;
    spring.onUpdate = (x) => { peak = Math.max(peak, x); };

    spring.to(100);
    settle(spring);

    assert.equal(peak > 100.5, overshoots, `reduced=${reduced} peak=${peak}`);
  }
  setReducedMotion(false);
});

test('retargeting mid-flight keeps the velocity', () => {
  setReducedMotion(false);
  const spring = new Spring(0);
  spring.to(100);
  advance(0.05);
  const velocity = spring.v;

  spring.to(-100);

  assert.equal(spring.v, velocity);
});

test('a kick springs back to where it was', () => {
  setReducedMotion(false);
  const spring = new Spring(1, { eps: 0.0005 });

  spring.to(1).kick(9);
  settle(spring);

  assert.equal(spring.x, 1);
});

test('under reduced motion a kick does nothing', () => {
  setReducedMotion(true);
  const spring = new Spring(1);

  spring.kick(9);

  assert.equal(spring.v, 0);
  setReducedMotion(false);
});
