/**
 * The stage's one gravity / rigid-body engine. Everything that flies free on the pet stage runs on
 * these same functions and constants: the figure body's throws and drops (web/kit/body.js) and the
 * props beside it, like the kickable basin (web/props/basin.js). They are pure functions over a
 * plain { x, y, vx, vy } state in stage pixels, so each caller keeps its own state and they all fall,
 * bounce and land alike.
 */

/** Downward acceleration, stage px/s². */
export const GRAVITY = 2300;
/** Horizontal air drag, an exponential decay rate (1/s). */
export const AIR_DRAG = .4;
/** Share of the speed kept when bouncing off a side wall. */
export const WALL_BOUNCE = .55;
/** Share of the speed kept when bouncing off the ceiling. */
export const CEIL_BOUNCE = .3;
/** What a landing above `settleSpeed` keeps off the floor, and what its skid leaves of the speed along it. */
export const FLOOR_BOUNCE = .42, FLOOR_SKID = .86;
/** A release (throw) speed is clamped to these, px/s. */
export const THROW_MAX_X = 1800, THROW_MAX_UP = 1800, THROW_MAX_DOWN = 1400;

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Integrates a free-flying state `s` ({ x, y, vx, vy }, stage px, `y` growing downward) one step of
 * `dt` seconds inside `bounds` { minX, maxX, ceilY, floorY } and mutates it. `x` is the body's centre,
 * `y` the line it rests on (its feet). Returns what happened this step, or null when nothing did:
 *   { side, ceil }         bounced off a side wall and/or the ceiling, still flying
 *   { bounce, side, ceil }  bounced off the floor (only when `o.floorBounce` is set and the landing was
 *                          harder than `o.settleSpeed`); `bounce` is the downward speed it arrived with
 *   { land, side, ceil }   came to rest on the floor; `land` is the downward speed it arrived with
 * The caller decides what a bounce or a landing looks and sounds like; the engine only moves. The body
 * asks for no floor bounce (it lands and stays), a loose prop asks for one (a basin rings on down).
 */
export function stepAir(s, dt, bounds, o = {}) {
  const gravity = o.gravity ?? GRAVITY, drag = o.drag ?? AIR_DRAG;
  const wallK = o.wallBounce ?? WALL_BOUNCE, ceilK = o.ceilBounce ?? CEIL_BOUNCE;
  s.vy += gravity * dt;
  s.vx *= Math.exp(-dt * drag);
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  let side = false, ceil = false;
  if (s.x < bounds.minX) { s.x = bounds.minX; s.vx = Math.abs(s.vx) * wallK; side = true; }
  if (s.x > bounds.maxX) { s.x = bounds.maxX; s.vx = -Math.abs(s.vx) * wallK; side = true; }
  if (s.y < bounds.ceilY && s.vy < 0) { s.y = bounds.ceilY; s.vy = Math.abs(s.vy) * ceilK; ceil = true; }
  if (s.y >= bounds.floorY && s.vy > 0) {
    const impact = s.vy;
    const floorK = o.floorBounce ?? 0;
    if (floorK > 0 && impact > (o.settleSpeed ?? 0)) {
      s.y = bounds.floorY; s.vy = -impact * floorK; s.vx *= o.floorSkid ?? 1;
      return { bounce: impact, side, ceil };
    }
    s.y = bounds.floorY; s.vy = 0; s.vx = 0;
    return { land: impact, side, ceil };
  }
  return side || ceil ? { side, ceil } : null;
}

/** Clamps a release velocity to the throw limits, so no throw outruns the stage. */
export const clampThrow = (vx, vy) => ({ x: clamp(vx, -THROW_MAX_X, THROW_MAX_X), y: clamp(vy, -THROW_MAX_UP, THROW_MAX_DOWN) });

/**
 * Turns a run of pointer positions into a release velocity: `push({ t, x, y })` records a point (t in
 * ms) and drops what fell out of the last `windowMs`; `get()` reads the speed across what is left.
 * `reset(p)` starts a new grab (at `p`, or empty); `shift(dx, dy)` moves every kept point, for a stage
 * that slid to another display mid-drag.
 */
export function createVelocitySampler(windowMs = 110) {
  let s = [];
  return {
    reset(p) { s = p ? [{ t: p.t, x: p.x, y: p.y }] : []; },
    push(p) {
      s.push({ t: p.t, x: p.x, y: p.y });
      while (s.length > 2 && p.t - s[0].t > windowMs) s.shift();
    },
    get() {
      if (s.length < 2) return { x: 0, y: 0 };
      const a = s[0], b = s[s.length - 1], dt = Math.max(.016, (b.t - a.t) / 1000);
      return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
    },
    shift(dx, dy) { for (const q of s) { q.x += dx; q.y += dy; } },
  };
}
