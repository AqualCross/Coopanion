import { describe, expect, it, vi } from 'vitest';
import { createInteraction } from '../packages/cortico-world-desktop-pet/web/props/interaction.js';
import { GRAVITY } from '../packages/cortico-world-desktop-pet/web/kit/physics.js';

// The page's body↔prop contact logic, run headless: fake body layouts and basin states in, the
// callbacks it asks for out. Nothing here moves a real body — that stays in kit/physics.js.
const whale = (x, mode, facing = 1) => ({ x, facing, mode, box: { x: x - 60, y: 300, w: 120, h: 200 } });
const basinAt = (x, over = {}) => ({ x, y: 460, vx: 0, vy: 0, w: 120, h: 60, air: false, dragging: false, resting: true, ...over });

const record = () => ({ kick: vi.fn(), hitBounce: vi.fn(), walkTo: vi.fn(), react: vi.fn() });

const run = (it, seconds, l, b, io, opts) => { for (let i = 0; i < seconds * 10; i++) it.step(0.1, l, b, io, opts); };

describe('walking past', () => {
  it('kicks a resting basin along the way it is going, once', () => {
    const io = record();
    const ix = createInteraction();
    const b = basinAt(300);
    // the body walks up so its leading foot crosses the basin
    ix.step(0.1, whale(255, 'walk'), b, io, { roam: 'off' });
    expect(io.kick).toHaveBeenCalledTimes(1);
    const [vx, vy] = io.kick.mock.calls[0];
    expect(vx).toBeGreaterThan(0);                          // sent to the right, the way it faces
    // a boot, not a push: it leaves the floor, and rises well clear of its own height
    expect((vy * vy) / (2 * GRAVITY)).toBeGreaterThan(b.h * 2);
    expect(vx).toBeGreaterThan(900);
    // the cooldown stops it kicking again on the next step
    ix.step(0.1, whale(260, 'walk'), b, io, { roam: 'off' });
    expect(io.kick).toHaveBeenCalledTimes(1);
  });

  it('does not kick a basin that is not in front of the step', () => {
    const io = record();
    const ix = createInteraction();
    // walking right, but the basin is well behind the leading foot
    ix.step(0.1, whale(100, 'walk'), basinAt(300), io, { roam: 'off' });
    expect(io.kick).not.toHaveBeenCalled();
  });

  it('does nothing while the basin is away (the setting has it off)', () => {
    const io = record();
    const ix = createInteraction();
    // a basin taken off the stage reports no state at all
    run(ix, 20, whale(255, 'walk'), null, io, { roam: 'free' });
    expect(io.kick).not.toHaveBeenCalled();
    expect(io.walkTo).not.toHaveBeenCalled();
  });
});

describe('struck by a thrown basin', () => {
  it('rebounds the basin and knocks the body dizzy', () => {
    const io = record();
    const ix = createInteraction();
    ix.step(0.1, whale(300, 'idle'), basinAt(340, { air: true, resting: false, vx: 900, vy: 0 }), io, {});
    expect(io.hitBounce).toHaveBeenCalledTimes(1);
    expect(io.hitBounce.mock.calls[0][0]).toBe(1);          // pushed away from the body, to the right
    expect(io.react).toHaveBeenCalledTimes(1);
  });

  it('leaves a slow drift alone', () => {
    const io = record();
    const ix = createInteraction();
    ix.step(0.1, whale(300, 'idle'), basinAt(330, { air: true, resting: false, vx: 100, vy: 0 }), io, {});
    expect(io.hitBounce).not.toHaveBeenCalled();
    expect(io.react).not.toHaveBeenCalled();
  });
});

describe('going for a kick', () => {
  it('sends the idle body walking to just past a resting basin', () => {
    const io = record();
    const ix = createInteraction();
    run(ix, 20, whale(100, 'idle'), basinAt(600), io, { roam: 'free' });
    expect(io.walkTo).toHaveBeenCalled();
    // it aims past the basin (to its far side), so the walk crosses it and the pass rule kicks it
    expect(io.walkTo.mock.calls[0][0]).toBeGreaterThan(600);
  });

  it('never goes wandering when roaming is off', () => {
    const io = record();
    const ix = createInteraction();
    run(ix, 20, whale(100, 'idle'), basinAt(600), io, { roam: 'off' });
    expect(io.walkTo).not.toHaveBeenCalled();
  });
});
