/**
 * The stage's toy: a prop that stands on the floor beside the figure body and falls, bounces and lands
 * on the very same gravity engine (web/kit/physics.js) with the very same constants, so a thrown toy and
 * a thrown pet arc alike. Tap it to kick it spinning, or hold and fling it; it rings off the walls and
 * the floor. What it looks like and what it is called are the person's: the dressing page gives it a
 * picture (`setSrc`) and a name (the World's `toy.name`), and the built-in one is an iron basin.
 *
 * Unlike a figure pack it is trusted page code, drawn straight onto the stage (not in a sandboxed
 * frame), so it may sit anywhere on the floor and take the pointer wherever it stands.
 *
 * `layer`: the element to draw into; `bounds()` → { W, H, floorY, S }; `sfx` the page's sounds
 * (web/sound.js); `src` the toy's picture.
 */
import { stepAir, clampThrow, createVelocitySampler, clamp, FLOOR_BOUNCE, FLOOR_SKID } from '../kit/physics.js';

const lerp = (a, b, k) => a + (b - a) * k;

/** The toy's longest side on the stage, in logo units at the body's scale (about the body's head). */
const TOY_LONG = 120;
/** The proportions to hold to before the picture has been measured (web/props/basin.png is 1536×755). */
const DEFAULT_ASPECT = 755 / 1536;
/** A tap-kick's impulse, px/s, and the spin it puts on, deg/s. */
const KICK_VX = [480, 760], KICK_VY = [700, 980], KICK_SPIN = [300, 620];
/** Below this landing speed (px/s) a toy stops bouncing and settles. */
const SETTLE_VY = 240;
/** How far the pointer must travel on a held toy before the hold becomes a drag. */
const GRAB_PX = 6;

export function createToy({ layer, bounds, sfx, src }) {
  const el = document.createElement('img');
  el.src = src;
  el.alt = '';
  el.draggable = false;
  el.className = 'prop toy';
  /** The picture's height as a share of its width, so any toy keeps its own proportions. */
  let ar = DEFAULT_ASPECT;
  el.addEventListener('load', () => {
    if (!(el.naturalWidth > 0)) return;
    ar = el.naturalHeight / el.naturalWidth;
    setBounds(bounds());
    draw();
  });
  const shadow = document.createElement('div');
  shadow.className = 'prop-shadow';
  layer.append(shadow, el);

  // the page's own synthesized tones (web/sound.js), so a pack's sound of the same name never stands in
  let soundOn = true;
  const play = (name, ...args) => { if (soundOn) sfx?.[name]?.(...args); };
  let W = 0, H = 0, floorY = 0, S = .42;
  /** Centre x and the line it rests on (its rim's bottom), stage px; vx/vy while flying. */
  const s = { x: 0, y: 0, vx: 0, vy: 0 };
  let air = false, placed = false, shown = true;
  let rot = 0, rotV = 0;             // spin, degrees and deg/s
  let sq = 0, sqv = 0;              // landing squash spring
  let press = null, dragging = false;
  let cursor = '';
  const sampler = createVelocitySampler();
  const pointer = { x: 0, y: 0 };

  const w = () => TOY_LONG * S / Math.max(1, ar), h = () => w() * ar;
  const minX = () => w() / 2 + 4, maxX = () => Math.max(minX(), W - w() / 2 - 4);
  const ceilY = () => h();

  function setBounds(b) {
    W = b.W; H = b.H; floorY = b.floorY; S = b.S ?? S;
    if (!placed && W > 0) { s.x = W * .3; s.y = floorY; placed = true; }
    s.x = clamp(s.x, minX(), maxX());
    if (!air) s.y = floorY;
  }
  setBounds(bounds());

  /** Whether stage point `p` is on the toy's box — with a little room about it, since the box is small. */
  function hit(p) {
    if (!shown) return false;
    const hw = w() / 2 + 6, hh = h() + 8;
    return p.x > s.x - hw && p.x < s.x + hw && p.y > s.y - hh && p.y < s.y + 8;
  }

  /** Take the toy off the stage (the `toy.enabled` setting): no picture, no falling, no touch. */
  function setVisible(on) {
    shown = on;
    el.hidden = !on;
    shadow.hidden = !on;
    if (!on) { press = null; dragging = false; cursor = ''; }
  }
  /** The toy's own sounds (the `toy.sound` setting). */
  function setSound(on) { soundOn = !!on; }
  /** Put the toy's picture in (the person picked one on the dressing page); its box follows it. */
  function setSrc(url) { if (el.getAttribute('src') !== url) el.src = url; }

  function kick(p) {
    // kicked away from the side that was touched, popping up and spinning
    const dir = p.x <= s.x ? 1 : -1;
    const r = (a, b) => a + Math.random() * (b - a);
    impulse(dir * r(...KICK_VX), -r(...KICK_VY), dir * r(...KICK_SPIN));
  }
  /** Send the toy flying with a set velocity — a tap-kick, a throw, or the body's passing step. */
  function impulse(vx, vy, spin) {
    s.vx = vx; s.vy = vy; rotV = spin;
    air = true; sqv -= 2;
    play('clang');
  }
  /** A thrown toy struck the body: rebound off it along `dirX` (away from the body) with a clang. */
  function hitBounce(dirX) {
    s.vx = dirX * (Math.abs(s.vx) * .4 + 120);
    s.vy = -Math.min(320, Math.abs(s.vy) * .4 + 120);
    air = true;
    play('clang', true);
  }
  /** The toy's state as the page's interaction logic reads it (props/interaction.js), null while it is away. */
  function state() {
    if (!shown) return null;
    return { x: s.x, y: s.y, vx: s.vx, vy: s.vy, w: w(), h: h(), air, dragging, resting: !air && !dragging };
  }

  /* pointer: stage-pixel coordinates; `p.t` is when it happened (ms), else now */
  const now = (p) => p?.t ?? performance.now();
  function pointerDown(p) {
    Object.assign(pointer, { x: p.x, y: p.y });
    if (!hit(p)) return false;
    press = { x: p.x, y: p.y, t: now(p) };
    dragging = false;
    sampler.reset({ t: now(p), x: p.x, y: p.y });
    return true;
  }
  function pointerMove(p) {
    const t = now(p);
    Object.assign(pointer, { x: p.x, y: p.y });
    if (!press) { cursor = hit(p) ? 'grab' : ''; return; }
    sampler.push({ t, x: p.x, y: p.y });
    if (!dragging && (air || Math.hypot(p.x - press.x, p.y - press.y) > GRAB_PX)) {
      dragging = true;
      air = true;             // a held toy is off the floor, so the engine carries it on release
      s.vx = 0; s.vy = 0;
      play('grab');
    }
    if (dragging) {
      s.x = clamp(p.x, minX(), maxX());
      s.y = clamp(p.y, ceilY(), floorY);
      rot = 0; rotV = 0;
      cursor = 'grabbing';
    }
  }
  function pointerUp(p) {
    cursor = '';
    if (!press) return;
    const held = now(p) - press.t;
    if (dragging) {
      const v = clampThrow(sampler.get().x, sampler.get().y);
      s.vx = v.x; s.vy = v.y;
      rotV = clamp(v.x * .12, -420, 420);
      air = true;
      const speed = Math.hypot(v.x, v.y);
      if (speed > 700) play('whoosh');
    } else if (held < 400) {
      kick(p);
    }
    press = null;
    dragging = false;
  }
  function pointerLeave() { if (!press) cursor = ''; }
  /** Keeps a held toy under the pointer when the stage slides to another display mid-drag. */
  function shift(dx, dy) {
    s.x += dx; s.y += dy;
    pointer.x += dx; pointer.y += dy;
    sampler.shift(dx, dy);
    if (press) { press.x += dx; press.y += dy; }
  }

  function tick(dt) {
    if (!shown) return;
    if (air && !dragging) {
      // a toy rings down the floor rather than stopping dead on it, so a hard kick skips along
      const ev = stepAir(s, dt, { minX: minX(), maxX: maxX(), ceilY: ceilY(), floorY },
        { floorBounce: FLOOR_BOUNCE, floorSkid: FLOOR_SKID, settleSpeed: SETTLE_VY });
      if (ev?.side) { rotV = -rotV * .6; play('clang', false); }
      if (ev?.bounce != null) {
        sqv += clamp(ev.bounce * .0016, .3, 1.6);
        rotV *= .8;
        play('clang', ev.bounce > 700);
      }
      if (ev?.land != null) {
        air = false;
        const impact = ev.land;
        sqv += clamp(impact * .004, .6, 5);
        rotV *= .25;
        play('clang', impact > 700);
      }
    } else if (!air) {
      // settle the spin back upright once it is on the floor
      rotV *= Math.exp(-dt * 6);
      rot += rotV * dt;
      rot = lerp(rot, 0, 1 - Math.exp(-dt * 10));
    }
    if (air) rot += rotV * dt;
    // squash spring
    sqv += ((0 - sq) * 280 - sqv * 14) * dt;
    sq = clamp(sq + sqv * dt, -.35, .45);
    draw();
  }

  function draw() {
    const bw = w(), bh = h();
    const up = clamp((floorY - s.y) / 400, 0, 1);   // how far off the floor, for the shadow
    el.style.width = bw + 'px';
    // the box turns about its bottom centre, so a tilted one reaches below that point: how far, measured
    // to its lowest corner. The floor then holds the toy up by that much instead of through it.
    const r = rot * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    const reach = Math.max(0, ...[[bw / 2, 0], [-bw / 2, 0], [bw / 2, -bh], [-bw / 2, -bh]]
      .map(([x, y]) => x * sn + y * cs));
    const anchorY = Math.min(s.y, floorY - reach);
    el.style.transform = `translate3d(${(s.x - bw / 2).toFixed(1)}px, ${(anchorY - bh).toFixed(1)}px, 0)`
      + ` rotate(${rot.toFixed(1)}deg) scale(${(1 + sq * .5).toFixed(3)}, ${(1 - sq).toFixed(3)})`;
    shadow.style.width = (bw * (1 - up * .35)).toFixed(1) + 'px';
    shadow.style.height = (bw * .14).toFixed(1) + 'px';
    shadow.style.opacity = (.3 * (1 - up * .8)).toFixed(2);
    shadow.style.transform = `translate3d(${(s.x - bw * (1 - up * .35) / 2).toFixed(1)}px, ${(floorY - bw * .07).toFixed(1)}px, 0)`;
  }

  function dispose() { el.remove(); shadow.remove(); }

  setBounds(bounds());
  draw();
  return {
    kind: 'toy',
    hit,
    setBounds,
    tick,
    shift,
    state,
    impulse,
    hitBounce,
    setVisible,
    setSound,
    setSrc,
    dispose,
    get cursor() { return cursor; },
    pointer(type, p) {
      if (type === 'down') return pointerDown(p);
      if (type === 'move') return pointerMove(p);
      if (type === 'up') return pointerUp(p);
      if (type === 'leave') return pointerLeave();
      return false;
    },
  };
}
