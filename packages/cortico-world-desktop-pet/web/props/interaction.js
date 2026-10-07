/**
 * The stage's body↔prop contact, decided on the page where both meet: the figure body lives in a
 * sandboxed frame and only reports where it stands (`layout`), a prop lives on the page, so this is
 * the one place that sees both and can let them touch. It reads their state and calls back through
 * `io` (kick the prop, walk the body, tell the body it was struck); it moves nothing itself, so the
 * gravity stays in kit/physics.js and this is pure, testable logic.
 *
 * Three things happen here:
 *  - a thrown basin that strikes the body bounces off it and the body is knocked dizzy on the spot
 *    (摔晕), the same dizzy it falls into when it comes down too hard;
 *  - the body walking past a resting basin kicks it along with that step (顺脚踢走);
 *  - now and then, when the basin rests out of reach and the body is idle, it sends the body walking
 *    to just past the basin — so it comes upon it and kicks it (主动去踢), the actual kick done by the
 *    pass rule above.
 */

const rnd = (a, b) => a + Math.random() * (b - a);
const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

/**
 * `step(dt, layout, basin, io, opts)` runs one frame.
 *  - `layout`: the body's reported layout (see body-host `readLayout`), or null before it is ready;
 *  - `basin`: the prop's state { x, y, vx, vy, w, h, air, dragging, resting }, or null;
 *  - `io`: { kick(vx, vy, spin), hitBounce(dirX), walkTo(x), react() };
 *  - `opts.roam`: the roaming setting — no seeking while it is 'off' (the person asked it to stay put).
 */
export function createInteraction() {
  let passCool = 0, hitCool = 0, seekIn = rnd(6, 12), seekTtl = 0, seeking = false, wasMoving = false;

  function step(dt, layout, basin, io, opts = {}) {
    passCool -= dt; hitCool -= dt; seekIn -= dt; if (seeking) seekTtl -= dt;
    if (!layout || !basin) { seeking = false; wasMoving = false; return; }

    const facing = layout.facing || 1, whaleX = layout.x, box = layout.box;
    const boxW = box ? box.w : basin.w;
    const moving = layout.mode === 'walk' || layout.mode === 'run';

    // a thrown basin strikes the body: it rebounds off, and the body is knocked dizzy
    if (basin.air && !basin.dragging && hitCool <= 0) {
      const speed = Math.hypot(basin.vx, basin.vy);
      const midY = basin.y - basin.h / 2;
      const over = !box || (midY > box.y && midY < box.y + box.h);
      if (over && Math.abs(basin.x - whaleX) < boxW * 0.4 + basin.w * 0.4 && speed > 260) {
        hitCool = 0.7;
        io.hitBounce(sign(basin.x - whaleX) || -facing);
        io.react();
      }
    }

    // walking past a basin at rest kicks it along with the step
    if (moving && basin.resting && passCool <= 0) {
      const reach = Math.max(50, boxW * 0.26);
      const foot = whaleX + facing * reach;
      const ahead = facing > 0 ? foot >= basin.x : foot <= basin.x;
      if (ahead && Math.abs(foot - basin.x) < basin.w * 0.6 + 18) {
        passCool = 0.9;
        // a real boot, not a nudge: mostly upward, so it goes off on a steep diagonal and skips down
        io.kick(facing * rnd(1250, 1650), -rnd(1600, 1950), facing * rnd(1300, 1900));
      }
    }

    // the body came back to rest after going for a kick: wait a while before the next one
    if (seeking && wasMoving && !moving) { seeking = false; seekIn = rnd(8, 16); }
    if (seeking && seekTtl <= 0) { seeking = false; seekIn = rnd(8, 16); }   // the walk never took (it was busy)

    // the basin rests out of reach and the body is idle: go and find it
    if (opts.roam !== 'off' && !moving && !seeking && basin.resting && seekIn <= 0 && Math.abs(basin.x - whaleX) > boxW * 1.1) {
      seeking = true; seekTtl = 6;
      const dir = sign(basin.x - whaleX) || 1;
      io.walkTo(basin.x + dir * (basin.w * 0.6 + 30));   // to just past it, so the walk crosses it
    }

    wasMoving = moving;
  }

  function reset() { passCool = hitCool = seekIn = 0; seekTtl = 0; seeking = wasMoving = false; }
  return { step, reset };
}
