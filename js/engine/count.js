// The second opinion on uniqueness: an exhaustive per-cell counter that shares nothing with the
// solver — not the permutation tables, not the line records, not even the sentinel constants.
//
// It carries its OWN copy of "how many towers does a viewer count", written from the definition in
// a different shape from the one in js/engine/perm.js, because the entire point of the second
// implementation is that a mistake in the first cannot show up in both. Sharing a constant table
// would make the cross-check "the file agrees with itself", which is worth nothing.
//
// It answers one question — how many completions does this clue set have? — and stops at `cap`,
// spending its node budget rather than lying about a board it could not finish counting. It holds
// no reasoning rule of any kind: no candidate sets, no "this clue forces this cell". Search lives
// here; the pencil path in skyscraper.js never looks at a single one of these nodes.
//
// The board's clue array is indexed side*n + line with sides 上/右/下/左 — that layout is re-derived
// here from the rules rather than imported, so a drift in js/engine/skyscraper.js's index arithmetic
// fails this file's answer against the solver's instead of hiding inside a shared helper.

const NOTHING = 0; // a cell with no height written yet
const ABSENT = -1; // an edge position carrying no clue

export const UNIQUE = 'UNIQUE';
export const MANY = 'MANY';
export const NONE = 'NONE';
export const OVERBUDGET = 'OVERBUDGET';

// Strict record highs along `line[0..len-1]`, read from the front — its own implementation.
function towersVisible(line, len) {
  let count = 0;
  let tallest = 0;
  for (let i = 0; i < len; i++) {
    if (line[i] > tallest) {
      tallest = line[i];
      count++;
    }
  }
  return count;
}

// Could this prefix still end up showing exactly `want` towers once the rest is filled?
// A prefix that already shows more has lost; one that shows fewer and has too few cells left has
// also lost, because a cell shows at most one new tower.
function prefixOk(seen, want, left) {
  if (seen > want) return false;
  if (seen + left < want) return false;
  return true;
}

export function countSolutions(board, { cap = 2, budget = 300000 } = {}) {
  const n = board.n;
  const clue = Int8Array.from(board.clue);
  const size = n * n;
  const grid = new Uint8Array(size);
  const rowUsed = new Int32Array(n);
  const colUsed = new Int32Array(n);
  const buf = new Int8Array(n);
  const topLeft = (r) => clue[3 * n + r];
  const rightClue = (r) => clue[n + r];
  const topClue = (c) => clue[c];
  const bottomClue = (c) => clue[2 * n + c];
  for (let i = 0; i < clue.length; i++) if (clue[i] === 0) throw new Error(`count.js: 线索位 ${i} 是 0，本作里 0 表示空格而不是哨兵`);
  for (let i = 0; i < clue.length; i++) if (clue[i] !== ABSENT && clue[i] < 1) throw new Error(`count.js: 非法线索 ${clue[i]}`);

  let nodes = 0;
  let solutions = 0;
  let first = null;
  let over = false;

  // checks the row through cell (r,c) and the column through it; both prefixes are contiguous here
  function okHere(r, c) {
    const i = r * n + c;
    const filledRow = c + 1;
    const filledCol = r + 1;
    for (let k = 0; k < n; k++) buf[k] = grid[r * n + k];
    const wantL = topLeft(r);
    if (wantL !== ABSENT && !prefixOk(towersVisible(buf, filledRow), wantL, n - filledRow)) return false;
    if (filledRow === n) {
      const wantR = rightClue(r);
      if (wantR !== ABSENT) {
        for (let k = 0; k < n; k++) buf[k] = grid[r * n + (n - 1 - k)];
        if (towersVisible(buf, n) !== wantR) return false;
      }
    }
    for (let k = 0; k < n; k++) buf[k] = grid[k * n + c];
    const wantT = topClue(c);
    if (wantT !== ABSENT && !prefixOk(towersVisible(buf, filledCol), wantT, n - filledCol)) return false;
    if (filledCol === n) {
      const wantB = bottomClue(c);
      if (wantB !== ABSENT) {
        for (let k = 0; k < n; k++) buf[k] = grid[(n - 1 - k) * n + c];
        if (towersVisible(buf, n) !== wantB) return false;
      }
    }
    return true;
  }

  function go(i) {
    if (nodes++ > budget) {
      over = true;
      return true;
    }
    if (i === size) {
      solutions++;
      if (!first) first = Uint8Array.from(grid);
      return solutions >= cap;
    }
    const r = Math.floor(i / n);
    const c = i % n;
    const freeRow = ~rowUsed[r];
    const freeCol = ~colUsed[c];
    for (let v = 1; v <= n; v++) {
      const b = 1 << v;
      if (!(freeRow & b) || !(freeCol & b)) continue;
      // the tallest tower cannot stand closer to an edge than that edge's clue demands
      if (v === n) {
        const need = topLeft(r);
        if (need !== ABSENT && c < need - 1) continue;
        const needR = rightClue(r);
        if (needR !== ABSENT && n - 1 - c < needR - 1) continue;
        const needT = topClue(c);
        if (needT !== ABSENT && r < needT - 1) continue;
        const needB = bottomClue(c);
        if (needB !== ABSENT && n - 1 - r < needB - 1) continue;
      }
      grid[i] = v;
      rowUsed[r] |= b;
      colUsed[c] |= b;
      let stop = false;
      if (okHere(r, c)) {
        if (go(i + 1)) stop = true;
      } else if (nodes > budget) {
        over = true;
        stop = true;
      }
      rowUsed[r] &= ~b;
      colUsed[c] &= ~b;
      grid[i] = NOTHING;
      if (stop) return true;
    }
    return false;
  }

  go(0);
  if (over) return { status: OVERBUDGET, solutions, nodes, first: null };
  return {
    status: solutions >= cap ? MANY : solutions === 1 ? UNIQUE : NONE,
    solutions,
    nodes,
    first,
  };
}

// The deliberately dumb reference: enumerate every Latin square that matches the given digits, with
// no clue information used during the search at all, and read the clues off each finished square.
// Exponential in a way nobody should run past n=5 (order 4 has 576 Latin squares, order 5 has
// 161280) — it exists so that `countSolutions`' pruning can be caught out on the small boards, and
// so tools/bake.mjs can prove the visible-count distribution against a closed form.
export function countNaive(board, { given = null, cap = Infinity } = {}) {
  const n = board.n;
  const clue = board.clue;
  const seed = given || new Uint8Array(n * n);
  const grid = Uint8Array.from(seed);
  const rowUsed = new Int32Array(n);
  const colUsed = new Int32Array(n);
  for (let i = 0; i < n * n; i++) {
    const v = grid[i];
    if (!v) continue;
    const r = Math.floor(i / n);
    const c = i % n;
    if (rowUsed[r] & (1 << v) || colUsed[c] & (1 << v)) return { solutions: 0, checked: 0, first: null, illegalGiven: true };
    rowUsed[r] |= 1 << v;
    colUsed[c] |= 1 << v;
  }
  let solutions = 0;
  let checked = 0;
  let first = null;

  function accepts() {
    checked++;
    const line = new Int8Array(n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) line[c] = grid[r * n + c];
      if (clue[3 * n + r] !== ABSENT && towersVisible(line, n) !== clue[3 * n + r]) return false;
      for (let c = 0; c < n; c++) line[c] = grid[r * n + (n - 1 - c)];
      if (clue[n + r] !== ABSENT && towersVisible(line, n) !== clue[n + r]) return false;
    }
    for (let c = 0; c < n; c++) {
      for (let r = 0; r < n; r++) line[r] = grid[r * n + c];
      if (clue[c] !== ABSENT && towersVisible(line, n) !== clue[c]) return false;
      for (let r = 0; r < n; r++) line[r] = grid[(n - 1 - r) * n + c];
      if (clue[2 * n + c] !== ABSENT && towersVisible(line, n) !== clue[2 * n + c]) return false;
    }
    return true;
  }

  function go(i) {
    if (solutions >= cap) return true;
    if (i === n * n) {
      if (!accepts()) return false;
      solutions++;
      if (!first) first = Uint8Array.from(grid);
      return solutions >= cap;
    }
    const r = Math.floor(i / n);
    const c = i % n;
    if (grid[i]) return go(i + 1);
    for (let v = 1; v <= n; v++) {
      const b = 1 << v;
      if (rowUsed[r] & b || colUsed[c] & b) continue;
      grid[i] = v;
      rowUsed[r] |= b;
      colUsed[c] |= b;
      if (go(i + 1)) {
        grid[i] = 0;
        rowUsed[r] &= ~b;
        colUsed[c] &= ~b;
        return true;
      }
      grid[i] = 0;
      rowUsed[r] &= ~b;
      colUsed[c] &= ~b;
    }
    return false;
  }
  go(0);
  return { solutions, checked, first };
}
