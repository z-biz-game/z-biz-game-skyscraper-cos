// The permutation tables the solver reasons over.
//
// The central object of this game's pencil path is: *the set of orderings of one line that agree
// with the clue written on the edge that line runs to*. Enumerating them is the honest thing to
// do — n! rows, 24 for 4x4 up to 5040 for 7x7, 40320 for 8x8 — and the tier ladder stops at 7, so
// a table is built once per board size and cached for the whole process.
//
// `visible` below is written straight from the definition: walk the line from the viewing edge and
// count strict record highs, because a tower of the same height cannot exist in the same line and
// the tallest tower ends the count. js/engine/count.js carries a SECOND copy of that same idea,
// deliberately not shared, for the second opinion on uniqueness (see DESIGN.md §3): if both read
// one implementation, an error in it would agree with itself.

export const MAX_N = 8;

// Count of towers seen looking down `values` from index 0 onward.
export function visible(values) {
  let seen = 0;
  let top = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > top) {
      top = values[i];
      seen++;
    }
  }
  return seen;
}

// How many towers are visible from the far end — the same walk, other direction.
export function visibleBack(values) {
  let seen = 0;
  let top = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] > top) {
      top = values[i];
      seen++;
    }
  }
  return seen;
}

const tables = new Map();

// { n, count, flat, visA, visB } — flat is count*n bytes, row i being one ordering.
export function permTable(n) {
  const hit = tables.get(n);
  if (hit) return hit;
  if (!(n >= 1 && n <= MAX_N)) throw new Error(`排列表只做到 ${MAX_N} 阶：请求了 ${n}`);
  const p = new Int8Array(n);
  const used = new Uint8Array(n + 1);
  const rows = [];
  const visA = [];
  const visB = [];
  (function build(k) {
    if (k === n) {
      const copy = Array.from(p);
      rows.push(copy);
      visA.push(visible(copy));
      visB.push(visibleBack(copy));
      return;
    }
    for (let v = 1; v <= n; v++) {
      if (used[v]) continue;
      used[v] = 1;
      p[k] = v;
      build(k + 1);
      used[v] = 0;
    }
  })(0);
  const flat = new Int8Array(rows.length * n);
  for (let i = 0; i < rows.length; i++) for (let k = 0; k < n; k++) flat[i * n + k] = rows[i][k];
  const table = {
    n,
    count: rows.length,
    flat,
    visA: Int8Array.from(visA),
    visB: Int8Array.from(visB),
  };
  tables.set(n, table);
  return table;
}

const compatCache = new Map();

// The orderings that match the clues on both ends of one line. A clue of NO_CLUE (-1) says nothing
// on its side, so it filters nothing — that is the whole reason NO_CLUE is -1 and not 0: with 0
// standing in for "absent", every line would be filtered against "可见数 = 0", which is not a
// number any line has, and the compatible set would come back empty.
export const NO_CLUE = -1;

export function compatible(n, clueA, clueB) {
  if (clueA === NO_CLUE && clueB === NO_CLUE) return null; // caller uses the cheaper all-different path
  const key = n * 100000 + (clueA + 1) * 1000 + (clueB + 1);
  const hit = compatCache.get(key);
  if (hit) return hit;
  const t = permTable(n);
  const out = [];
  for (let i = 0; i < t.count; i++) {
    if (clueA !== NO_CLUE && t.visA[i] !== clueA) continue;
    if (clueB !== NO_CLUE && t.visB[i] !== clueB) continue;
    out.push(i);
  }
  const list = Int32Array.from(out);
  compatCache.set(key, list);
  return list;
}

// How many orderings of 1..n show exactly k towers from one edge: the distribution the engine's
// own table is measured against in tools/bake.mjs. Two independent routes to the same numbers —
// enumeration here, the Stirling recurrence there — is the point.
export function distribution(n) {
  const t = permTable(n);
  const out = new Int32Array(n + 1);
  for (let i = 0; i < t.count; i++) out[t.visA[i]]++;
  return out;
}

export const value = (n, permIndex, k) => permTable(n).flat[permIndex * n + k];
