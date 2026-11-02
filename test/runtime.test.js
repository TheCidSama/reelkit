// Pure-math half of the runtime: runs in Node, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ease, toEase, spring, springs, springDuration, tween, keys, rng, hash, noise, mix, rgba, layoutScenes, typingTimes, clamp } from '../runtime/reel.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test('every easing maps 0 -> 0 and 1 -> 1', () => {
  for (const [name, f] of Object.entries(ease)) {
    if (name === 'bezier') continue;
    close(f(0), 0, 1e-6); close(f(1), 1, 1e-6);
  }
});

test('in/out easings are monotonic', () => {
  for (const name of ['linear', 'in', 'out', 'inOut', 'outQuint', 'inOutQuint', 'outExpo', 'inOutExpo', 'inOutSine', 'smooth', 'snap']) {
    let prev = -Infinity;
    for (let i = 0; i <= 200; i++) { const v = ease[name](i / 200); assert.ok(v >= prev - 1e-9, `${name} not monotonic at ${i}`); prev = v; }
  }
});

test('cubic bezier matches the CSS "ease" curve at known points', () => {
  const e = ease.bezier(0.25, 0.1, 0.25, 1);
  close(e(0.5), 0.8024, 2e-3);
});

test('unknown easing names throw a helpful error', () => {
  assert.throws(() => toEase('bouncy-ish'), /unknown easing/);
});

test('spring starts at `from`, settles at `to`', () => {
  for (const name of Object.keys(springs)) {
    close(spring(0, name), 0);
    close(spring(10, name), 1, 1e-4);
  }
  close(spring(5, { from: 20, to: -3, stiffness: 200, damping: 20 }), -3, 1e-3);
});

test('analytic spring agrees with a fine-step numerical simulation (under, critical, over damped)', () => {
  const cases = [{ stiffness: 300, damping: 12, mass: 1 }, { stiffness: 100, damping: 20, mass: 1 }, { stiffness: 100, damping: 60, mass: 2 }, { stiffness: 170, damping: 26, mass: 1, velocity: 8 }];
  for (const o of cases) {
    let x = 0, v = o.velocity || 0;
    const dt = 1e-5;
    for (let i = 1; i <= 100000; i++) {          // 1 s, semi-implicit Euler
      const a = (-o.stiffness * (x - 1) - o.damping * v) / o.mass;
      v += a * dt; x += v * dt;
      if (i % 25000 === 0) close(spring(i * dt, o), x, 2e-3);
    }
  }
});

test('bouncy springs overshoot, critically damped ones do not', () => {
  const peak = name => Math.max(...Array.from({ length: 300 }, (_, i) => spring(i / 100, name)));
  assert.ok(peak('bouncy') > 1.2);
  assert.ok(peak('smooth') <= 1.0000001);
});

test('springDuration is finite and ordered by stiffness', () => {
  const snappy = springDuration('snappy'), gentle = springDuration('gentle');
  assert.ok(snappy > 0.2 && snappy < 2, `snappy ${snappy}`);
  assert.ok(gentle > snappy);
});

test('tween clamps and eases', () => {
  assert.equal(tween(0, 1, 1), 0);
  assert.equal(tween(5, 1, 1), 1);
  close(tween(1.5, 1, 1, 'linear'), 0.5);
});

test('keys interpolates numbers, objects, arrays and colours', () => {
  const f = [[0, 0], [1, 10, 'linear'], [2, 10]];
  close(keys(0.5, f), 5); assert.equal(keys(-1, f), 0); assert.equal(keys(9, f), 10);
  assert.deepEqual(keys(0.5, [[0, { x: 0, y: 10 }], [1, { x: 10, y: 0 }, 'linear']]), { x: 5, y: 5 });
  assert.deepEqual(keys(0.5, [[0, [0, 0]], [1, [2, 4], 'linear']]), [1, 2]);
  assert.equal(keys(0.5, [[0, '#000000'], [1, '#ffffff', 'linear']]), 'rgba(128,128,128,1)');
});

test('rng is deterministic per seed and uniform-ish', () => {
  const a = rng(7), b = rng(7), c = rng(8);
  const sa = Array.from({ length: 1000 }, a), sb = Array.from({ length: 1000 }, b), sc = Array.from({ length: 5 }, c);
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa.slice(0, 5), sc);
  const mean = sa.reduce((x, y) => x + y) / sa.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05);
  assert.ok(sa.every(v => v >= 0 && v < 1));
});

test('hash and noise are pure functions', () => {
  assert.equal(hash(1, 2, 3), hash(1, 2, 3));
  assert.notEqual(hash(1, 2, 3), hash(3, 2, 1));
  assert.equal(noise(3.7, 2), noise(3.7, 2));
  for (let x = 0; x < 20; x += 0.37) assert.ok(Math.abs(noise(x, 1)) <= 1);
});

test('colour helpers', () => {
  assert.equal(rgba('#ff0000', 0.5), 'rgba(255,0,0,0.5)');
  assert.equal(rgba('#f00'), 'rgba(255,0,0,1)');
  assert.equal(mix('#000000', '#ffffff', 0), 'rgba(0,0,0,1)');
});

test('layoutScenes overlaps transitions', () => {
  const tl = layoutScenes([
    { name: 'a', duration: 3 },
    { name: 'b', duration: 2, transition: { type: 'fade', duration: 0.5 } },
    { name: 'c', duration: 2 },
  ]);
  assert.deepEqual(tl.map(s => [s.start, s.end]), [[0, 3], [2.5, 4.5], [4.5, 6.5]]);
  assert.throws(() => layoutScenes([{ name: 'a', duration: 0.2 }, { name: 'b', duration: 2, transition: { type: 'fade', duration: 0.5 } }]), /longer than/);
});

test('typingTimes are increasing and deterministic', () => {
  const t = typingTimes('npm install reelkit', 20);
  assert.equal(t.length, 19);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
  assert.deepEqual(t, typingTimes('npm install reelkit', 20));
  assert.equal(clamp(5), 1);
});
