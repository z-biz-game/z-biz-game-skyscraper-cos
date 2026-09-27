// Generator. Solution first: plant a Latin square of heights, and the counts on the four edges
// *are* the clues (cluesFrom) — so a board cannot be born unsolvable, which is the opposite of
// guessing a clue set and hoping.
//
// One thing that makes this game different from the rest of the family: a fully clued Skyscrapers
// board is NOT automatically unique. Two rows and two columns can carry the same two heights in
// either order and show the same counts from all four edges — the "deadly pattern" — so the full
// clue set has to be *tested*, not trusted. The test used here is the pencil path: if `solve()`
// cannot walk the board from an empty grid, the grid is rejected outright. That is sound in the
// direction that matters, because every write the rules make holds in *every* solution, so a board
// the pencil path finishes has exactly one solution. It can reject a board that is unique but needs
// a step these rules do not cover — a false reject costs one more try, a false accept would ship a
// guessable puzzle.
//
// The measured cost of that wall (tools/balance.mjs prints it): a *random* order-6 grid has a unique
// full clue set about 1 time in 40, and no random order-7 grid in a sample of 40 was solvable by
// the pencil path at all. That is why the shipped size ladder stops at 6 and not at 7 — see
// DESIGN.md §5 for the numbers and the reasoning.
//
// Difficulty then comes from the one knob the game actually has: how many of those edge numbers get
// removed. A removal is kept only if the pencil path still finishes, so "unique" and "no guessing"
// are the same test here, and js/engine/count.js exists to check the two have not drifted apart.

import { NO_CLUE, EMPTY, createBoard, cluesFrom, solve, derive, bit, pop } from './skyscraper.js';

export function mix(seed) {
  let x = typeof seed === 'string' ? 2166136261 : seed >>> 0;
  if (typeof seed === 'string') {
    for (let i = 0; i < seed.length; i++) {
      x ^= seed.charCodeAt(i);
      x = Math.imul(x, 16777619) >>> 0;
    }
  }
  x = x || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

function shuffled(list, rand) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// A random Latin square on the heights 1..n: fill cells in scan order with a shuffled choice of the
// heights still free in that row and column, backtracking when a corner is painted in. This is the
// answer side of the board, never shown to the player.
export function randomLatin(n, rand, { budget = 40000 } = {}) {
  const grid = new Uint8Array(n * n);
  const rowUsed = new Int32Array(n);
  const colUsed = new Int32Array(n);
  let nodes = 0;
  const options = [];
  function go(i) {
    if (i === n * n) return true;
    const r = Math.floor(i / n);
    const c = i % n;
    options.length = 0;
    for (let v = 1; v <= n; v++) {
      const b = 1 << v;
      if (!(rowUsed[r] & b) && !(colUsed[c] & b)) options.push(v);
    }
    for (const v of shuffled(options, rand)) {
      if (nodes++ > budget) return false;
      const b = 1 << v;
      grid[i] = v;
      rowUsed[r] |= b;
      colUsed[c] |= b;
      if (go(i + 1)) return true;
      rowUsed[r] &= ~b;
      colUsed[c] &= ~b;
      grid[i] = 0;
    }
    return false;
  }
  return go(0) ? grid : null;
}

// How far the pencil path got, as one number: a finished cell is worth more than any number of
// candidates erased, so deletions are judged on progress first and pencil lead second.
function progress(dv) {
  let placed = 0;
  let cleared = 0;
  for (let i = 0; i < dv.placed.length; i++) {
    if (dv.placed[i] !== EMPTY) placed++;
    else cleared += pop(dv.domain[i]);
  }
  return placed * 1000 - cleared;
}

// Greedy deletion, in shuffled order, down to `target` surviving clues (0 = delete as far as the
// pencil path tolerates). Every candidate removal re-runs the pencil path: that is the whole cost
// of the zero-guess promise, and the reason a band is measured rather than declared. Returns the
// clue array *and* the numbers that were taken out, in the order they went, because the tier knobs
// need to be able to hand some of them back.
export function pruneClues(board, rand, target = 0) {
  const clue = Int8Array.from(board.clue);
  let kept = board.clues;
  let cur = progress(derive(createBoard({ n: board.n, clue })));
  const removed = [];
  for (const i of shuffled([...Array(clue.length).keys()], rand)) {
    if (kept <= target) break;
    if (clue[i] === NO_CLUE) continue;
    const before = clue[i];
    clue[i] = NO_CLUE;
    const probe = createBoard({ n: board.n, clue });
    const dv = derive(probe);
    // progress must not fall: a deletion that lets the pencil path stall somewhere earlier is a
    // board the player can no longer finish, so it goes straight back.
    if (!dv.conflict && progress(dv) <= cur) {
      kept--;
      cur = progress(dv);
      removed.push(i);
    } else clue[i] = before;
  }
  return { clue, removed, kept };
}

// Hand `extras` clues back, picked at random from the ones that were removed. More printed numbers
// is the easy direction: a clue that reads 1 or n hands out whole cells for free, so the same grid
// can be served soft or hard without ever changing its solution. Re-adding cannot break the pencil
// path (a stronger clue set only ever proves more), and cannot make the given set inconsistent,
// because every number here was read off the planted grid.
export function resupply(full, clue, removed, rand, extras) {
  const out = Int8Array.from(clue);
  let given = 0;
  for (const i of shuffled(removed, rand)) {
    if (given >= extras) break;
    if (out[i] !== NO_CLUE) continue;
    out[i] = full[i];
    given++;
  }
  return out;
}

// One grid, one clue set. `tries` samples grids from the seed and keeps the one whose measured score
// sits closest to `band`, so a tier's band is a selection target the generator aims at, not a label
// it declares.
export function generate(opts = {}) {
  const {
    n = 5,
    seed = 'plain',
    target = 0,
    extras = 0,
    band = null,
    tries = 24,
    report = () => {},
  } = opts;
  let best = null;
  let sampled = 0;
  let rejected = { noLatin: 0, ambiguous: 0, stalled: 0 };
  for (let k = 0; k < tries; k++) {
    const trial = `${seed}#${k}`;
    const rand = mix(trial);
    sampled++;
    const solution = randomLatin(n, rand);
    if (!solution) {
      rejected.noLatin++;
      continue;
    }
    let board;
    let clue;
    try {
      const full = createBoard({ n, clue: cluesFrom(n, solution) });
      // fully clued first: if even all 4n numbers cannot walk it, this grid admits no clue set that
      // a player could finish without guessing (a subset of clues is never stronger)
      if (!solve(full).ok) {
        rejected.ambiguous++;
        continue;
      }
      const pruned = pruneClues(full, rand, target);
      clue = resupply(full.clue, pruned.clue, pruned.removed, rand, extras);
      board = createBoard({ n, clue });
      if (!solve(board).ok) {
        rejected.stalled++;
        continue;
      }
    } catch {
      rejected.ambiguous++;
      continue;
    }
    const p = solve(board);
    if (!p.ok) continue;
    const offBand = band ? Math.abs(p.score - clamp(p.score, band[0], band[1])) : 0;
    const cand = {
      board,
      solution,
      seed: trial,
      score: p.score,
      steps: p.steps,
      places: p.places,
      prunes: p.prunes,
      eliminated: p.eliminated,
      rounds: p.rounds,
      depth: p.depth,
      breakdown: p.breakdown,
      clues: board.clues,
      offBand,
      gen: k + 1,
    };
    report({ k, score: p.score, clues: board.clues, offBand });
    if (!best || cand.offBand < best.offBand) best = cand;
    if (band && cand.offBand === 0) break;
  }
  if (!best) return { ok: false, board: null, sampled, rejected, reason: '没找到既唯一又能纯逻辑推到底的盘面' };
  return { ok: true, sampled, rejected, ...best };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// The five rungs below are cut from measurement, not from intention: `band` is what tools/balance.mjs
// observed this tier actually scoring (its printed quantile table is the evidence), and the same
// file fails the build if a rung stops landing inside its own band or the medians stop ordering.
// `target` is how far the greedy deletion is pushed — the one axis this game has — and `tries` is
// how many grids it may sample to land in band, which the order-6 accept rate (5.5%, DESIGN.md §5)
// forces to be far larger than the order-4 one.
export const TIERS = [
  { key: 'novice', name: '初学', n: 4, target: 14, extras: 0, tries: 60, band: [42, 64] },
  { key: 'casual', name: '上手', n: 4, target: 9, extras: 0, tries: 60, band: [58, 80] },
  { key: 'regular', name: '熟练', n: 5, target: 18, extras: 0, tries: 140, band: [108, 126] },
  { key: 'sharp', name: '高阶', n: 5, target: 12, extras: 0, tries: 140, band: [127, 145] },
  { key: 'master', name: '大师', n: 6, target: 18, extras: 0, tries: 260, band: [196, 240] },
];

export function tierFor(key) {
  return TIERS.find((t) => t.key === key) || TIERS[1];
}

export function puzzleFromTier(tier, seed) {
  return generate({ n: tier.n, target: tier.target, extras: tier.extras, band: tier.band, tries: tier.tries, seed });
}

// A puzzle is (seed, tier) and nothing else — the store persists those two, so this function has to
// be a pure function of them. Wall-clock time must never enter a selection key (DESIGN.md §8).
export function makePuzzle(seed, tierKey) {
  const tier = tierFor(tierKey);
  const r = puzzleFromTier(tier, seed);
  if (!r.ok) return null;
  return {
    ...r,
    tier: tier.key,
    tierName: tier.name,
    originSeed: seed,
    size: `${tier.n}×${tier.n}`,
    n: tier.n,
    w: tier.n,
    h: tier.n,
  };
}

// The daily board and the campaign both come from here, so "today's puzzle" is the same object for
// the browser, the bake step and the verifier.
export function dailySeed(key) {
  return `daily:${key}`;
}
