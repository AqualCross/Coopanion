import { describe, expect, it } from 'vitest';
import {
  stepAir, clampThrow, createVelocitySampler,
  GRAVITY, AIR_DRAG, WALL_BOUNCE, CEIL_BOUNCE, THROW_MAX_X, THROW_MAX_DOWN,
} from '../packages/cortico-world-desktop-pet/web/kit/physics.js';

// The stage's one gravity engine: the figure body's throws (kit/body.js) and the props beside it
// (props/toy.js) both fall on these numbers. A change here moves everything on the stage, so it is
// pinned against the values the kit has always used.
const BOUNDS = { minX: 100, maxX: 900, ceilY: 60, floorY: 380 };

describe('stepAir', () => {
  it('accelerates a falling body by GRAVITY and moves it by its velocity', () => {
    const s = { x: 500, y: 100, vx: 0, vy: 0 };
    stepAir(s, 1 / 60, { ...BOUNDS, floorY: 1e9 });   // no floor: pure fall
    expect(s.vy).toBeCloseTo(GRAVITY / 60, 5);
    expect(s.y).toBeCloseTo(100 + GRAVITY / 60 / 60, 5);
  });

  it('drags horizontal speed down exponentially', () => {
    const s = { x: 500, y: 100, vx: 600, vy: 0 };
    stepAir(s, 1 / 60, { ...BOUNDS, floorY: 1e9 });
    expect(s.vx).toBeCloseTo(600 * Math.exp(-(1 / 60) * AIR_DRAG), 5);
  });

  it('bounces off a side wall at WALL_BOUNCE and reports the side hit', () => {
    const s = { x: 105, y: 200, vx: -1000, vy: 0 };
    const ev = stepAir(s, 1 / 60, { ...BOUNDS, floorY: 1e9 }, { drag: 0 });   // no drag: isolate the bounce
    expect(s.x).toBe(BOUNDS.minX);
    expect(s.vx).toBeCloseTo(1000 * WALL_BOUNCE, 3);
    expect(ev).toMatchObject({ side: true });
  });

  it('bounces off the ceiling at CEIL_BOUNCE only while rising', () => {
    const s = { x: 500, y: 61, vx: 0, vy: -500 };
    stepAir(s, 1 / 60, { ...BOUNDS, floorY: 1e9 });
    const rising = -500 + GRAVITY / 60;                 // gravity is applied before the move
    expect(s.y).toBe(BOUNDS.ceilY);
    expect(s.vy).toBeCloseTo(Math.abs(rising) * CEIL_BOUNCE, 3);
  });

  it('comes to rest on the floor and reports the impact it arrived with', () => {
    const s = { x: 500, y: 379, vx: 200, vy: 400 };
    const ev = stepAir(s, 1 / 60, BOUNDS);
    expect(ev.land).toBeGreaterThan(400);           // gravity added on the way into the floor
    expect(s.y).toBe(BOUNDS.floorY);
    expect(s.vy).toBe(0);
    expect(s.vx).toBe(0);
  });

  // asking for no floor bounce is the figure body's setting: it lands where it comes down
  it('skips a hard landing back off the floor when the caller asks it to bounce', () => {
    const s = { x: 500, y: 379, vx: 900, vy: 400 };
    const ev = stepAir(s, 1 / 60, BOUNDS, { floorBounce: .5, floorSkid: .8, settleSpeed: 240 });
    expect(ev.bounce).toBeGreaterThan(400);
    expect(ev.land).toBeUndefined();
    expect(s.y).toBe(BOUNDS.floorY);
    expect(s.vy).toBeLessThan(0);                        // thrown back up
    expect(s.vx).toBeCloseTo(900 * Math.exp(-(1 / 60) * AIR_DRAG) * .8, 3);   // the skid thins it
  });

  it('settles instead of bouncing once a landing falls under the settle speed', () => {
    const s = { x: 500, y: 379, vx: 200, vy: 400 };
    const ev = stepAir(s, 1 / 60, BOUNDS, { floorBounce: .5, settleSpeed: 1e5 });
    expect(ev.bounce).toBeUndefined();
    expect(ev.land).toBeGreaterThan(400);
    expect(s.vy).toBe(0);
  });
});

describe('clampThrow', () => {
  it('caps the release speed to the stage limits', () => {
    expect(clampThrow(9999, -9999)).toEqual({ x: THROW_MAX_X, y: -THROW_MAX_X });
    expect(clampThrow(-9999, 9999)).toEqual({ x: -THROW_MAX_X, y: THROW_MAX_DOWN });
    expect(clampThrow(120, -340)).toEqual({ x: 120, y: -340 });
  });
});

describe('createVelocitySampler', () => {
  it('reads the speed across the points kept in the window', () => {
    const v = createVelocitySampler(110);
    v.reset({ t: 0, x: 0, y: 0 });
    v.push({ t: 100, x: 200, y: 0 });
    expect(v.get()).toEqual({ x: 2000, y: 0 });
  });

  it('keeps the last two points and drops older ones out of the window', () => {
    const v = createVelocitySampler(110);
    v.reset({ t: 0, x: 0, y: 0 });
    v.push({ t: 50, x: 50, y: 0 });
    v.push({ t: 400, x: 400, y: 0 });   // the point at t=0 is older than 110ms behind the newest, so it drops
    expect(v.get()).toEqual({ x: (400 - 50) / .35, y: 0 });   // read across the two points kept
  });
});
