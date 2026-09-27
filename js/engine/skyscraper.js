// Skyscrapers / Towers engine.
//
// The board is a Latin square in disguise: every row and every column holds the heights 1..n once
// each, and the number printed outside the grid says how many towers a viewer standing on that edge
// can see — a tower is hidden behind any tower at least as tall as it, and once the tallest (n) is
// in sight nothing further can add to the count. That single sentence is the whole rule, and it is
// what makes one constraint worth more than any other here: a line is not "some cells differ", it is
// "one of these n! orderings", so the solver can ask a line what it allows instead of guessing.
//
// `solve()` below is the pencil path. It is the player's route, the generator's acceptance test and
// the source of every hint, so it never backtracks and never reads the player's ink. Search lives
// only in count.js, and the generator trusts neither of them on the other's word.
//
// Why every write is safe: the values written below are always "true in every ordering compatible
// with this line's clue", and the restriction of any solution to a line *is* such an ordering. So
// each write holds in every solution of the board — which is what lets the hints be honest, and
// lets "推得完" imply "解唯一".

import { compatible, permTable, visible, visibleBack, NO_CLUE, MAX_N } from './perm.js';

export { NO_CLUE, MAX_N };

// A cell with nothing written in it. Deliberately not the same constant as NO_CLUE even though both
// would work as 0: the two live in different arrays, and one future edit that reuses the other's
// sentinel is how a whole clue set silently disappears (DESIGN.md §2).
export const EMPTY = 0;

export const SIDES = ['上', '右', '下', '左'];

export const bit = (v) => 1 << v;
export const fullMask = (n) => ((1 << (n + 1)) - 1) & ~bit(0);
export const pop = (m) => {
  let k = 0;
  while (m) {
    m &= m - 1;
    k++;
  }
  return k;
};
export const valuesIn = (m) => {
  const out = [];
  for (let v = 1; v < 32; v++) if (m & bit(v)) out.push(v);
  return out;
};

// ---- board ------------------------------------------------------------------

// Clue layout, 4n entries: side 0 = 上 (column c, looking down), 1 = 右 (row r, looking left),
// 2 = 下 (column c, looking up), 3 = 左 (row r, looking right). Index = side * n + line.
export const clueIndex = (n, side, line) => side * n + line;

export function createBoard({ n, clue }) {
  if (!(n >= 2 && n <= MAX_N)) throw new Error(`盘尺寸只能是 2..${MAX_N}，收到 ${n}`);
  if (!clue || clue.length !== 4 * n) throw new Error('clue length mismatch');
  const arr = Int8Array.from(clue);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v === NO_CLUE) continue;
    if (v < 1 || v > n) {
      throw new Error(`${clueName(n, i)} 写着 ${v}，可线索只能是 1..${n}（${NO_CLUE} 表示这条边没有线索）`);
    }
  }
  let clues = 0;
  for (const v of arr) if (v !== NO_CLUE) clues++;
  if (!clues) throw new Error('盘上一条线索都没有');

  const tracks = [];
  const cellTracks = Array.from({ length: n * n }, () => []);
  for (let r = 0; r < n; r++) {
    const cells = new Uint16Array(n);
    for (let c = 0; c < n; c++) cells[c] = r * n + c;
    tracks.push(makeTrack(n, tracks.length, 'row', r, cells, clueIndex(n, 3, r), clueIndex(n, 1, r), arr));
  }
  for (let c = 0; c < n; c++) {
    const cells = new Uint16Array(n);
    for (let r = 0; r < n; r++) cells[r] = r * n + c;
    tracks.push(makeTrack(n, tracks.length, 'col', c, cells, clueIndex(n, 0, c), clueIndex(n, 2, c), arr));
  }
  for (const t of tracks) for (let k = 0; k < n; k++) cellTracks[t.cells[k]].push([t.id, k]);

  const board = {
    n,
    size: n * n,
    clue: arr,
    clues,
    tracks,
    cellTracks,
    cellName: (i) => `第${Math.floor(i / n) + 1}行第${(i % n) + 1}列`,
    clueName: (i) => clueName(n, i),
    trackName: (id) => tracks[id].name,
  };
  return board;
}

function makeTrack(n, id, kind, line, cells, idxA, idxB, clue) {
  const name = `${line + 1}${kind === 'row' ? '行' : '列'}`;
  const clueA = clue[idxA];
  const clueB = clue[idxB];
  if (clueA > 0 && clueB > 0 && clueA + clueB > n + 1) {
    // The tallest tower is visible from both ends, so the two counts share one sighting:
    // cA + cB - 1 <= n. Handled at construction so an impossible given never reaches the solver.
    throw new Error(`第${name} 两端写着 ${clueA} 和 ${clueB}：${n} 层盘上一条线最多看见 ${n} 栋，两端加起来不能超过 ${n + 1}`);
  }
  return {
    id,
    kind,
    line,
    name,
    cells,
    idxA,
    idxB,
    clueA,
    clueB,
    // the orderings of this line that agree with whatever this line's edges say
    perms: compatible(n, clueA, clueB),
    clued: clueA !== NO_CLUE || clueB !== NO_CLUE,
  };
}

// The clue set a finished grid implies, on all four edges. Used by the generator to plant a board
// that certainly has a solution — and by nothing that judges one.
export function cluesFrom(n, grid) {
  const out = new Int8Array(4 * n);
  out.fill(NO_CLUE);
  const line = new Int8Array(n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) line[c] = grid[r * n + c];
    out[clueIndex(n, 3, r)] = visible(line);
    out[clueIndex(n, 1, r)] = visibleBack(line);
  }
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) line[r] = grid[r * n + c];
    out[clueIndex(n, 0, c)] = visible(line);
    out[clueIndex(n, 2, c)] = visibleBack(line);
  }
  return out;
}

export function clueName(n, i) {
  const side = SIDES[Math.floor(i / n)];
  const line = (i % n) + 1;
  const which = side === '上' || side === '下' ? `${line}列` : `${line}行`;
  return `${which} ${side}边`;
}

// ---- the rules a player could say out loud -----------------------------------

export const Rules = {
  one: {
    key: 'one',
    name: '只见一栋',
    weight: 1,
    level: 1,
    text: (b, s) => `${b.clueName(s.clueIdx)}写着 1：望进去只看得见一栋，那第一眼撞上的就是最高的 ${b.n} 楼，所以 ${b.cellName(s.cell)} 必须是 ${b.n}`,
  },
  all: {
    key: 'all',
    name: '一栋不落',
    weight: 1,
    level: 1,
    text: (b, s) => `${b.clueName(s.clueIdx)}写着 ${b.n}：${b.n} 栋全要看得见，从这一边往里必须一路升高，所以 ${b.cellName(s.cell)} 是 ${s.value}`,
  },
  cap: {
    key: 'cap',
    name: '第一格的顶',
    weight: 0.6,
    level: 2,
    text: (b, s) => `${b.clueName(s.clueIdx)}写着 ${s.clue}：第一格后面还得留出 ${s.clue - 1} 栋更高的，所以它最高只能是 ${s.cap}，${b.cellName(s.cell)} 上的 ${s.values.join('/')} 划掉`,
  },
  window: {
    key: 'window',
    name: '最高楼的位置',
    weight: 1,
    level: 2,
    text: (b, s) => `${b.clueName(s.clueIdx)}写着 ${s.clue}：${b.n} 楼得站在从它数过去第 ${s.clue} 格或更靠里才数得进去，${b.cellName(s.cell)} 在第 ${s.k} 格，太靠前了——${b.n} 从这个格的候选里划掉`,
  },
  windowOnly: {
    key: 'windowOnly',
    name: '最高楼只有一格可站',
    weight: 2,
    level: 2,
    text: (b, s) => `${b.n} 楼在 ${b.trackName(s.track)} 里只剩 ${b.cellName(s.cell)} 站得下（要求：${s.why}）`,
  },
  set: {
    key: 'set',
    name: '整行相容排列集',
    weight: 2.2,
    level: 3,
    text: (b, s) => `${b.trackName(s.track)} 剩下的每一种摆法都把 ${s.value} 写在 ${b.cellName(s.cell)}（约束来自 ${cluePair(b, s.track)}）`,
  },
  setHidden: {
    key: 'setHidden',
    name: '这个数只剩一格可放',
    weight: 2.6,
    level: 3,
    text: (b, s) => `在 ${b.trackName(s.track)} 剩下的每一种摆法里，${s.value} 都只能落在 ${b.cellName(s.cell)}（约束来自 ${cluePair(b, s.track)}）`,
  },
  setPrune: {
    key: 'setPrune',
    name: '排列集排除候选',
    weight: 1,
    level: 3,
    text: (b, s) => `${b.cellName(s.cell)} 若放成 ${s.values.join('/')}，${b.trackName(s.track)} 就没有任何一种摆法对得上 ${cluePair(b, s.track)}——这些候选划掉`,
  },
  line: {
    key: 'line',
    name: '同行不重复',
    weight: 0.5,
    level: 1,
    text: (b, s) => `${b.trackName(s.track)} 里已经写了 ${s.list}，同一行同一列不能有两个一样的高度，${b.cellName(s.cell)} 上的这些划掉`,
  },
  lineOnly: {
    key: 'lineOnly',
    name: '这一行只剩一格',
    weight: 1.8,
    level: 2,
    text: (b, s) => `${b.trackName(s.track)} 里 ${s.value} 只剩 ${b.cellName(s.cell)} 一格能放`,
  },
  lineSingleton: {
    key: 'lineSingleton',
    name: '候选只剩一个',
    weight: 1.6,
    level: 2,
    text: (b, s) => `${b.cellName(s.cell)} 的候选被两边的线收到只剩 ${s.value}`,
  },
  hallHidden: {
    key: 'hallHidden',
    name: '几个数只挤得下几格',
    weight: 3.4,
    level: 4,
    text: (b, s) => `${b.trackName(s.track)} 的每一种摆法里，${s.family.join('/')} 这 ${s.family.length} 个数只能站在 ${s.cells.map((c) => b.cellName(c)).join('、')}——正好 ${s.cells.length} 格，所以这几格里别的数都待不住（约束来自 ${cluePair(b, s.track)}）`,
  },
  hallNaked: {
    key: 'hallNaked',
    name: '几格只装得下这几个数',
    weight: 3.0,
    level: 4,
    text: (b, s) => `${b.trackName(s.track)} 里 ${s.cells.map((c) => b.cellName(c)).join('、')} 这 ${s.cells.length} 格只能装 ${s.family.join('/')}，正好 ${s.family.length} 个数，所以这一行/列其余各格的 ${s.family.join('/')} 都划掉（约束来自 ${cluePair(b, s.track)}）`,
  },
};

export const RULE_LIST = Object.values(Rules);

// "第3行 左边 4、右边 2" — the pair of edge readings a whole-line deduction rests on. A hint that
// cannot point at the clue it used is not a hint, so every rule text goes through here.
export function cluePair(b, trackId) {
  const t = b.tracks[trackId];
  const parts = [];
  if (t.clueA !== NO_CLUE) parts.push(`${b.clueName(t.idxA)} ${t.clueA}`);
  if (t.clueB !== NO_CLUE) parts.push(`${b.clueName(t.idxB)} ${t.clueB}`);
  return parts.join('、') || '（这条线两端都没有线索）';
}

// ---- derivation --------------------------------------------------------------

// A derivation is the pencil path's own state: which heights are settled, and which are still
// standing as candidates. Nothing about the player's ink enters here.
export function createDerivation(board) {
  const full = fullMask(board.n);
  return {
    board,
    placed: new Uint8Array(board.size),
    domain: Int32Array.from({ length: board.size }, () => full),
    conflict: null,
  };
}

function fail(dv, message, extra) {
  if (!dv.conflict) dv.conflict = { message, ...extra };
}

function write(dv, cell, value, rule, steps, ctx) {
  const cur = dv.placed[cell];
  if (cur === value) return true;
  if (cur !== EMPTY) {
    fail(dv, `${dv.board.cellName(cell)} 已经写了 ${cur}，可 ${rule.name} 说这里必须是 ${value}`, { cell, clueIdx: ctx.clueIdx });
    return false;
  }
  if (ctx.track != null) {
    const t = dv.board.tracks[ctx.track];
    for (let k = 0; k < t.cells.length; k++) {
      if (t.cells[k] !== cell && dv.placed[t.cells[k]] === value) {
        fail(dv, `${rule.name} 要 ${dv.board.cellName(cell)} 放 ${value}，可 ${t.name} 里已经有 ${value} 了`, { cell, clueIdx: ctx.clueIdx });
        return false;
      }
    }
  }
  dv.placed[cell] = value;
  dv.domain[cell] = bit(value);
  steps.push({ kind: 'place', cell, value, rule, ...ctx });
  return true;
}

function drop(dv, cell, mask, rule, steps, ctx) {
  const removed = dv.domain[cell] & mask;
  if (!removed) return 0;
  dv.domain[cell] &= ~mask;
  if (dv.domain[cell] === 0) {
    fail(dv, `${dv.board.cellName(cell)} 的候选被排空了：${valuesIn(removed).join('/')} 都不行，可这一格还得站一座楼`, { cell, clueIdx: ctx.clueIdx });
    return pop(removed);
  }
  steps.push({ kind: 'prune', cell, values: valuesIn(removed), elim: pop(removed), rule, ...ctx });
  return pop(removed);
}

// Subsets of heights and of positions, prepared once per board size: the Hall sweep below runs on
// every line on every sweep, and it is the one place where the pencil path enumerates rather than
// reads off a support table.
const subsetCache = new Map();
function subsets(n) {
  const hit = subsetCache.get(n);
  if (hit) return hit;
  const of = (offset) => {
    const out = [];
    for (let m = 1; m < (1 << n); m++) {
      const members = [];
      for (let k = 0; k < n; k++) if (m & (1 << k)) members.push(k + offset);
      if (members.length >= 2 && members.length <= n - 1) out.push({ mask: m, size: members.length, members });
    }
    return out;
  };
  const table = { vals: of(1), poss: of(0) };
  subsetCache.set(n, table);
  return table;
}

const maskOf = (list) => list.reduce((m, v) => m | bit(v), 0);

// Hall families on one line's survivor set, in both directions:
//   (a) if k heights together can only stand in exactly k cells, those cells hold nothing else;
//   (b) if k cells together can only hold k heights, no other cell in the line holds any of them.
// Both are statements about the orderings of *this* line, so each write still holds in every
// solution of the board — and both reach strictly further than per-cell support checking, which is
// exactly the gap that makes a fully clued 6x6 stall without them (DESIGN.md §4).
function hallSweep(dv, t, atK, byV, steps) {
  const n = dv.board.n;
  const edgeIdx = t.clueA !== NO_CLUE ? t.idxA : t.idxB;
  const { vals, poss } = subsets(n);
  for (const sub of vals) {
    let pos = 0;
    for (const v of sub.members) pos |= byV[v];
    if (pop(pos) !== sub.size) continue;
    const cells = [];
    for (let k = 0; k < n; k++) if (pos & (1 << (k + 1))) cells.push(t.cells[k]);
    for (const cell of cells) {
      if (dv.placed[cell] !== EMPTY) continue;
      drop(dv, cell, dv.domain[cell] & ~maskOf(sub.members), Rules.hallHidden, steps, {
        track: t.id,
        clueIdx: edgeIdx,
        family: sub.members,
        cells,
      });
      if (dv.conflict) return;
    }
  }
  for (const sub of poss) {
    let vm = 0;
    for (const k of sub.members) vm |= atK[k];
    if (pop(vm) !== sub.size) continue;
    const cells = sub.members.map((k) => t.cells[k]);
    for (let k = 0; k < n; k++) {
      if (sub.mask & (1 << k)) continue;
      const cell = t.cells[k];
      if (dv.placed[cell] !== EMPTY) continue;
      drop(dv, cell, dv.domain[cell] & vm, Rules.hallNaked, steps, {
        track: t.id,
        clueIdx: edgeIdx,
        family: valuesIn(vm),
        cells,
      });
      if (dv.conflict) return;
    }
  }
}

// One sweep of the pencil path. Rules are applied in the order a solver reaches for them: the cheap
// edge readings first, then the line taken as a whole. Every step carries the clue index it came
// from, because a hint that cannot name its clue is not a hint.
export function propagate(dv, steps) {
  const board = dv.board;
  const n = board.n;
  const before = steps.length;

  // 1. what a single clue says on its own: the tower it sees first, how tall that tower can be, and
  //    the window the tallest tower has to stand in.
  for (const t of board.tracks) {
    for (const end of [0, 1]) {
      const clue = end === 0 ? t.clueA : t.clueB;
      if (clue === NO_CLUE) continue;
      const clueIdx = end === 0 ? t.idxA : t.idxB;
      const at = (k) => t.cells[end === 0 ? k : n - 1 - k];
      if (clue === 1) {
        // only one tower in sight, and the first one is always in sight
        if (!write(dv, at(0), n, Rules.one, steps, { clueIdx, track: t.id, end })) return false;
        continue;
      }
      if (clue === n) {
        // every tower in sight means strictly increasing all the way, i.e. 1,2,…,n from this edge
        for (let k = 0; k < n; k++) if (!write(dv, at(k), k + 1, Rules.all, steps, { clueIdx, track: t.id, end })) return false;
        continue;
      }
      // behind the first tower there must still be clue-1 taller ones, so the first is at most n-clue+1
      const cap = n - clue + 1;
      let tooTall = 0;
      for (let v = cap + 1; v <= n; v++) tooTall |= bit(v);
      drop(dv, at(0), tooTall, Rules.cap, steps, { clueIdx, track: t.id, end, clue, cap });
      if (dv.conflict) return false;
    }
    // 2. the window the tallest tower can stand in, read from both ends of the line at once
    if (t.clued) {
      const lo = t.clueA === NO_CLUE ? 0 : t.clueA - 1;
      const hi = t.clueB === NO_CLUE ? n - 1 : n - t.clueB;
      if (lo > hi) {
        fail(dv, `${t.name} 两边的线索 ${t.clueA} 和 ${t.clueB} 互相排斥：${n} 楼没有位置可站`, { track: t.id });
        return false;
      }
      let topPlaced = false;
      for (let k = 0; k < n; k++) if (dv.placed[t.cells[k]] === n) topPlaced = true;
      if (!topPlaced) {
        const why = [
          t.clueA === NO_CLUE ? '' : `从${board.clueName(t.idxA)}数第 ${t.clueA} 格或更靠里`,
          t.clueB === NO_CLUE ? '' : `从${board.clueName(t.idxB)}数第 ${t.clueB} 格或更靠里`,
        ].filter(Boolean).join('，');
        const room = [];
        for (let k = lo; k <= hi; k++) if (dv.placed[t.cells[k]] === EMPTY) room.push(k);
        if (room.length === 1) {
          if (!write(dv, t.cells[room[0]], n, Rules.windowOnly, steps, { track: t.id, clueIdx: t.clueA !== NO_CLUE ? t.idxA : t.idxB, why })) return false;
        }
        for (let k = 0; k < n; k++) {
          if (k >= lo && k <= hi) continue;
          if (dv.placed[t.cells[k]] !== EMPTY) continue;
          const fromA = k < lo;
          const clueIdx = fromA ? t.idxA : t.idxB;
          const clue = fromA ? t.clueA : t.clueB;
          if (clue === NO_CLUE) continue;
          drop(dv, t.cells[k], bit(n), Rules.window, steps, {
            track: t.id,
            clueIdx,
            clue,
            k: fromA ? k + 1 : n - k,
          });
          if (dv.conflict) return false;
        }
      }
    }
  }

  // 3. the line taken as a whole: which of its compatible orderings survive everything written so far
  const flat = permTable(n).flat;
  for (const t of board.tracks) {
    if (t.clued) {
      const survivors = surviving(dv, t);
      if (!survivors.length) {
        fail(dv, `${t.name} 已经没有相容的摆法：写下的数和这条线两端的线索对不上了`, { track: t.id });
        return false;
      }
      const atK = new Int32Array(n); // values still possible at position k
      const byV = new Int32Array(n + 1); // positions still possible for height v
      for (const pi of survivors) {
        const base = pi * n;
        for (let k = 0; k < n; k++) {
          const v = flat[base + k];
          atK[k] |= bit(v);
          byV[v] |= bit(k + 1);
        }
      }
      const edgeIdx = t.clueA !== NO_CLUE ? t.idxA : t.idxB;
      for (let k = 0; k < n; k++) {
        const cell = t.cells[k];
        if (dv.placed[cell] !== EMPTY) continue;
        const gone = dv.domain[cell] & ~atK[k];
        if (gone) {
          drop(dv, cell, gone, Rules.setPrune, steps, { track: t.id, clueIdx: edgeIdx, clue: t.clueA !== NO_CLUE ? t.clueA : t.clueB });
          if (dv.conflict) return false;
        }
        if (pop(dv.domain[cell]) === 1) {
          write(dv, cell, valuesIn(dv.domain[cell])[0], Rules.set, steps, { track: t.id, clueIdx: edgeIdx });
          if (dv.conflict) return false;
        }
      }
      for (let v = 1; v <= n; v++) {
        if (pop(byV[v]) !== 1) continue;
        const k = valuesIn(byV[v])[0] - 1;
        const cell = t.cells[k];
        if (dv.placed[cell] !== EMPTY) continue;
        write(dv, cell, v, Rules.setHidden, steps, { track: t.id, value: v, clueIdx: edgeIdx });
        if (dv.conflict) return false;
      }
      // 4. families of heights and cells that only fit together — beyond per-cell support
      hallSweep(dv, t, atK, byV, steps);
      if (dv.conflict) return false;
    } else {
      // no clue on either end: the line is still one ordering of 1..n, which is the all-different fact
      let used = 0;
      for (let k = 0; k < n; k++) if (dv.placed[t.cells[k]] !== EMPTY) used |= bit(dv.placed[t.cells[k]]);
      for (let k = 0; k < n; k++) {
        const cell = t.cells[k];
        if (dv.placed[cell] !== EMPTY) continue;
        if (used) {
          drop(dv, cell, used, Rules.line, steps, { track: t.id, list: valuesIn(used).join('/') });
          if (dv.conflict) return false;
        }
        if (pop(dv.domain[cell]) === 1) {
          write(dv, cell, valuesIn(dv.domain[cell])[0], Rules.lineSingleton, steps, { track: t.id });
          if (dv.conflict) return false;
        }
      }
      for (let v = 1; v <= n; v++) {
        if (used & bit(v)) continue;
        let where = -1;
        let count = 0;
        for (let k = 0; k < n; k++) {
          const cell = t.cells[k];
          if (dv.placed[cell] === EMPTY && dv.domain[cell] & bit(v)) { count++; where = k; }
        }
        if (count === 1) {
          write(dv, t.cells[where], v, Rules.lineOnly, steps, { track: t.id, value: v });
          if (dv.conflict) return false;
        }
      }
    }
  }
  return steps.length > before;
}

// The orderings of this line that agree with the clue set *and* with everything written so far.
function surviving(dv, t) {
  const n = dv.board.n;
  const flat = permTable(n).flat;
  const out = [];
  outer: for (const pi of t.perms) {
    const base = pi * n;
    for (let k = 0; k < n; k++) {
      const cell = t.cells[k];
      const v = flat[base + k];
      if (dv.placed[cell] !== EMPTY) {
        if (dv.placed[cell] !== v) continue outer;
      } else if (!(dv.domain[cell] & bit(v))) continue outer;
    }
    out.push(pi);
  }
  return out;
}

// ---- the pencil path ---------------------------------------------------------

export function derive(board, seedPlaced = null, seedDomain = null) {
  const dv = createDerivation(board);
  if (seedPlaced) {
    for (let i = 0; i < board.size; i++) {
      const v = seedPlaced[i];
      if (v === EMPTY) continue;
      dv.placed[i] = v;
      dv.domain[i] = bit(v);
    }
  }
  if (seedDomain) dv.domain = Int32Array.from(seedDomain);
  const steps = [];
  let rounds = 0;
  for (;;) {
    const changed = propagate(dv, steps);
    if (dv.conflict) break;
    if (!changed) break;
    if (++rounds > 400) {
      fail(dv, '推导没有收敛（引擎缺陷）', {});
      break;
    }
  }
  dv.steps = steps;
  dv.rounds = rounds;
  return dv;
}

// The whole pencil path from an empty board. Returns the derivation in order — that list *is* the
// hint script, and it never looks at the player's ink, so a wrong digit cannot teach the hints to
// agree with it.
export function solve(board) {
  const dv = derive(board);
  const breakdown = {};
  let score = 0;
  let deepest = 0;
  let places = 0;
  let prunes = 0;
  let eliminated = 0;
  for (const s of dv.steps) {
    const gain = s.kind === 'place' ? s.rule.weight : s.rule.weight * s.elim;
    score += gain;
    breakdown[s.rule.name] = (breakdown[s.rule.name] || 0) + 1;
    deepest = Math.max(deepest, s.rule.level);
    if (s.kind === 'place') places++;
    else {
      prunes++;
      eliminated += s.elim;
    }
  }
  const filled = dv.placed.every((v) => v !== EMPTY);
  const ok = !dv.conflict && filled;
  return {
    ok,
    conflict: dv.conflict ? dv.conflict.message : null,
    conflictAt: dv.conflict || null,
    derived: dv.placed,
    domain: dv.domain,
    rows: dv.steps,
    steps: dv.steps.length,
    places,
    prunes,
    eliminated,
    rounds: dv.rounds,
    depth: deepest,
    score: Math.round(score * 10) / 10,
    breakdown,
  };
}

// ---- is this ink still survivable? -------------------------------------------

// Every write the line rules make holds in *every* solution, so seeding the player's own digits and
// running those rules until something contradicts is a proof of death, not a guess. The converse
// does not hold — the rules are incomplete — so this can only ever say "these digits already lost",
// never "this is fine".
export function reachable(board, cell) {
  const dv = derive(board, cell);
  return !dv.conflict;
}

export function deadEnd(board, cell) {
  const dv = derive(board, cell);
  return dv.conflict ? dv.conflict.message : null;
}

// ---- judgement read straight off the board -----------------------------------

// Written from the rules of the game, not from the derivation: a row and a column must each hold
// 1..n once, and every clue must equal what a viewer on that edge counts. Nothing here reads the
// hint script, so a bug in the propagation cannot fake a win.
export function verify(board, grid) {
  const n = board.n;
  const bad = [];
  for (let i = 0; i < board.size; i++) if (grid[i] === EMPTY) bad.push({ why: '空格', cell: i });
  const line = new Int8Array(n);
  for (const t of board.tracks) {
    const hole = t.cells.some((c) => grid[c] === EMPTY);
    if (hole) continue;
    for (let k = 0; k < n; k++) line[k] = grid[t.cells[k]];
    const seen = new Set(line);
    if (seen.size !== n) bad.push({ why: '重复高度', track: t.id, line: [...seen].join(',') });
    if (t.clueA !== NO_CLUE && visible(line) !== t.clueA) bad.push({ why: '线索对不上', clue: t.idxA, want: t.clueA, got: visible(line) });
    if (t.clueB !== NO_CLUE && visibleBack(line) !== t.clueB) bad.push({ why: '线索对不上', clue: t.idxB, want: t.clueB, got: visibleBack(line) });
  }
  return bad;
}

export function complete(board, grid) {
  if (grid.some((v) => v === EMPTY)) return false;
  return verify(board, grid).length === 0;
}

// Per-clue and per-cell verdicts for the renderer and the state line. Kept separate from verify()
// because these must work on a half-filled board: a clue counts as broken only when no completion
// of the ink can satisfy it, and as met only when its line is full and adds up.
export function diagnose(board, grid, notes = null) {
  const n = board.n;
  let filled = 0;
  for (let i = 0; i < board.size; i++) if (grid[i] !== EMPTY) filled++;
  const violated = new Set();
  const satisfied = new Set();
  const badCells = new Set();
  for (const t of board.tracks) {
    const vals = [];
    for (let k = 0; k < n; k++) {
      const v = grid[t.cells[k]];
      if (v !== EMPTY) vals.push([k, v]);
    }
    const counts = new Map();
    for (const [, v] of vals) counts.set(v, (counts.get(v) || 0) + 1);
    for (const [k, v] of vals) if (counts.get(v) > 1) { badCells.add(t.cells[k]); void v; }
    const dup = counts.size !== vals.length;
    for (const end of [0, 1]) {
      const idx = end === 0 ? t.idxA : t.idxB;
      const want = end === 0 ? t.clueA : t.clueB;
      if (want === NO_CLUE) continue;
      if (dup) { violated.add(idx); continue; }
      const order = end === 0 ? vals : vals.slice().reverse();
      // what the viewer already sees through the front of the ink, and how much is still open
      let seen = 0;
      let top = 0;
      let prefix = 0;
      for (const [k, v] of order) {
        const pos = end === 0 ? k : n - 1 - k;
        if (pos !== prefix) break;
        prefix++;
        if (v > top) { top = v; seen++; }
      }
      const full = prefix === n;
      if (seen > want || (full && seen !== want)) violated.add(idx);
      else if (full && seen === want) satisfied.add(idx);
      else if (seen + (n - prefix) < want) violated.add(idx);
    }
  }
  const noteErrors = notes ? noteConflicts(board, grid, notes) : [];
  return {
    filled,
    total: board.size,
    remaining: board.size - filled,
    clues: board.clues,
    violated,
    satisfied,
    badCells,
    noteErrors,
    conflicts: violated.size,
  };
}

// Candidates the player wrote that the clues have already ruled out. Sound by construction: the
// domains below only ever lose values that are provably impossible.
export function noteConflicts(board, grid, notes) {
  const dv = derive(board, grid);
  const out = [];
  for (let i = 0; i < board.size; i++) {
    const mask = notes[i];
    if (!mask || grid[i] !== EMPTY) continue;
    const gone = mask & ~dv.domain[i];
    if (gone) {
      out.push({ cell: i, values: valuesIn(gone), why: `${board.cellName(i)} 的 ${valuesIn(gone).join('/')} 已经被线索排除，笔记里不该还留着` });
    }
  }
  return out;
}

// The next thing the clues force that the player has not written yet — used when a hint has to work
// off the board as it stands rather than off the script.
export function nextDeduction(board, grid) {
  const dv = derive(board, grid);
  if (dv.conflict) return { conflict: dv.conflict.message };
  for (const s of dv.steps) if (grid[s.cell] === EMPTY) return { step: s, domains: dv.domain };
  return { step: null, domains: dv.domain };
}

// ---- the player's own ink ----------------------------------------------------

export function createState(board) {
  return {
    board,
    cell: new Uint8Array(board.size),
    notes: new Int32Array(board.size),
    history: [],
  };
}

export function snapshot(st) {
  st.history.push({ cell: Uint8Array.from(st.cell), notes: Int32Array.from(st.notes) });
  if (st.history.length > 400) st.history.shift();
  return st;
}

export function undo(st) {
  const last = st.history.pop();
  if (!last) return false;
  st.cell.set(last.cell);
  st.notes.set(last.notes);
  return true;
}

export function setCell(st, i, value) {
  if (i < 0 || i >= st.board.size) return false;
  if (st.cell[i] === value) return false;
  if (value !== EMPTY && (value < 1 || value > st.board.n)) return false;
  snapshot(st);
  st.cell[i] = value;
  if (value !== EMPTY) st.notes[i] = 0; // a written digit and a pencil mark are not the same thing
  return true;
}

export function toggleNote(st, i, value) {
  if (i < 0 || i >= st.board.size) return false;
  if (st.cell[i] !== EMPTY) return false; // a written digit is not a pencil mark
  const b = bit(value);
  if (!b || value < 1 || value > st.board.n) return false;
  snapshot(st);
  st.notes[i] ^= b;
  return true;
}

export function clearNotes(st) {
  const any = st.notes.some((m) => m !== 0);
  if (!any) return false;
  snapshot(st);
  st.notes.fill(0);
  return true;
}

export function resetInk(st) {
  st.cell.fill(EMPTY);
  st.notes.fill(0);
  st.history.length = 0;
  return st;
}
