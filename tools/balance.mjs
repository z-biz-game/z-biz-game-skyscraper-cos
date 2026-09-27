// The measuring stick: `npm run balance` generates SAMPLES puzzles per tier and prints the score
// quantiles, then fails (exit 1) on the ladder gate. It is the only place the difficulty claim is
// checked, so the numbers below come out of live generation — nothing here reads a canned table.
//
//   npm run balance                      # 8 samples per tier
//   SAMPLES=24 npm run balance           # the table quoted in README/DESIGN
//   WALL=400 npm run balance             # longer "how rare is a workable grid?" probe
//
// Two gates, both deliberately falsifiable:
//   1. landing rate  — at least BAND_FILL of a tier's accepted boards sit inside its own band, and
//      its median sits inside too. A band nobody can reach is not a difficulty, it is a build that
//      never finishes.
//   2. monotony      — tier medians strictly increase. This is the one place "初学 < 上手" is
//      something the machine checks rather than something the copy claims.
//
// The wall probe is reported, not gated: it measures how often a *random* grid of each size has a
// full clue set the pencil path can finish, which is what caps the shipped ladder at 6.
//
// Every sampled board is also cross-checked for uniqueness by js/engine/count.js — a generator that
// quietly started shipping two-solution boards would fail here and not in the browser.

import { createBoard, cluesFrom, solve } from '../js/engine/skyscraper.js';
import { TIERS, makePuzzle, randomLatin, mix } from '../js/engine/generate.js';
import { countSolutions, countNaive } from '../js/engine/count.js';
import { distribution } from '../js/engine/perm.js';

const SAMPLES = Number(process.env.SAMPLES || 8);
const WALL = Number(process.env.WALL || 120);
const BAND_FILL = Number(process.env.BAND_FILL || 0.75);
// The counting budget is not a formality: a sparse 6×6 board the pencil path finishes in
// milliseconds took 18,377,715 nodes to count exhaustively (2.3 s), where the order-5 boards need
// well under 10,000. `countSolutions` reports OVERBUDGET rather than guessing, and OVERBUDGET is a
// failure here, not a pass — so the budget below has to cover the measured worst case with room to
// spare, or the master tier's uniqueness would go unproven.
const COUNT_BUDGET = Number(process.env.COUNT_BUDGET || 60000000);

const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
// The first row only — see the comment at the countNaive call below for why 6×6 needs a pin.
const firstRow = (n, grid) => {
  const given = new Uint8Array(n * n);
  for (let c = 0; c < n; c++) given[c] = grid[c];
  return given;
};
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  return ok;
};

// ---- the wall: how rare is a grid the pencil path can finish on its own clues? ------------
console.log('\n== 全线索可行性（随机盘 4n 条线索全给，铅笔路径能不能从头推到完）==');
console.log('  n   抽样   可推完    比例     备注');
const wall = {};
for (const n of [4, 5, 6, 7]) {
  let ok = 0;
  let tried = 0;
  for (let k = 0; k < WALL; k++) {
    const solution = randomLatin(n, mix(`wall-${n}-${k}`));
    if (!solution) continue;
    tried++;
    let board;
    try {
      board = createBoard({ n, clue: cluesFrom(n, solution) });
    } catch {
      continue; // two ends of one line adding to more than n+1 cannot happen off a real grid
    }
    if (solve(board).ok) ok++;
  }
  wall[n] = { ok, tried, rate: ok / Math.max(1, tried) };
  console.log(`  ${n}   ${String(tried).padStart(4)}   ${String(ok).padStart(5)}   ${(100 * wall[n].rate).toFixed(1).padStart(6)}%   ${n >= 6 ? '这一档以下才会出货' : ''}`);
}
check(wall[4].rate > 0.5, `n=4 全线索可推完率跌到 ${(100 * wall[4].rate).toFixed(1)}%，引擎退化了`);
check(wall[6].rate < wall[5].rate, 'n=6 比 n=5 更好推？全线索率顺序反了，说明统计有假');

// ---- quantile table ----------------------------------------------------------------------
console.log('\n== 五档分位表（每档现场生成 SAMPLES 题）==');
const rows = [];
const header = ['档位', '阶', 'target', '线索', '分数min', 'p25', 'p50', 'p75', 'p90', 'max', '步数p50', '轮数p50', '规则深度', '入带率', 'ms p50', 'ms p90'];
console.log('  ' + header.map((h) => h.padStart(7)).join(' '));
const byTier = new Map();

for (const tier of TIERS) {
  const scores = [];
  const clueCounts = [];
  const steps = [];
  const rounds = [];
  const times = [];
  const nodes = [];
  const depths = new Set();
  let inBand = 0;
  const rej = { noLatin: 0, ambiguous: 0, stalled: 0 };
  let sampled = 0;
  for (let k = 0; k < SAMPLES; k++) {
    const start = performance.now();
    const p = makePuzzle(`balance-${tier.key}-${k}`, tier.key);
    times.push(performance.now() - start);
    if (!p) {
      check(false, `${tier.key}: 第 ${k} 题没能在 ${tier.tries} 次尝试里造出来`);
      continue;
    }
    scores.push(p.score);
    clueCounts.push(p.clues);
    steps.push(p.steps);
    rounds.push(p.rounds);
    depths.add(p.depth);
    sampled += p.sampled || 0;
    if (p.rejected) for (const key of Object.keys(rej)) rej[key] += p.rejected[key];
    if (p.score >= tier.band[0] && p.score <= tier.band[1]) inBand++;
    // independent uniqueness: the search counter must say UNIQUE, cell by cell, on every sample.
    // solve() is re-run here rather than trusted from the generator, so a stale `score` printed by
    // one pass and a fresh pass would also show up.
    const fresh = solve(p.board);
    check(fresh.ok && fresh.score === p.score, `${tier.key} 样本 ${k}: 重跑铅笔路径得到 ${fresh.score}/${fresh.ok}，生成时记的是 ${p.score}`);
    const derived = fresh.derived;
    const c = countSolutions(p.board, { cap: 2, budget: COUNT_BUDGET });
    nodes.push(c.nodes);
    check(
      c.status === 'UNIQUE',
      `${tier.key} 样本 ${k}: 逐格回溯计数器判 ${c.status}（nodes ${c.nodes}${c.status === 'OVERBUDGET' ? '，预算不够——不是不唯一，是没数完' : ''}），而铅笔路径说推得完`,
    );
    if (c.status === 'UNIQUE') {
      let differs = -1;
      for (let i = 0; i < c.first.length; i++) if (c.first[i] !== derived[i]) { differs = i; break; }
      check(differs === -1, `${tier.key} 样本 ${k}: 两条独立路线在第 ${differs + 1} 格给出不同高度`);
      // The third, dumbest opinion: enumerate Latin squares and read the clues off each finished one,
      // with no clue pruning in the search at all. Up to 5×5 that is the entire space (576 and
      // 161,280 squares). An order-6 board has 812,851,200 of them, so there the pin is the first row
      // of the pencil answer — 1,128,960 squares, ~0.6 s, still an independent route to the same
      // square. It cannot by itself prove global uniqueness at 6×6; that job stays with
      // countSolutions above, which is why both are run rather than the cheaper one.
      const naive = tier.n <= 5
        ? countNaive(p.board, { cap: 2 })
        : countNaive(p.board, { cap: 2, given: firstRow(tier.n, derived) });
      check(naive.solutions === 1, `${tier.key} 样本 ${k}: 朴素枚举给出 ${naive.solutions} 个解（访问 ${naive.checked} 个拉丁方）`);
      if (naive.first) {
        let nd = -1;
        for (let i = 0; i < naive.first.length; i++) if (naive.first[i] !== derived[i]) { nd = i; break; }
        check(nd === -1, `${tier.key} 样本 ${k}: 朴素枚举的答案与铅笔路径不同`);
      }
    }
  }
  scores.sort((a, b) => a - b);
  times.sort((a, b) => a - b);
  nodes.sort((a, b) => a - b);
  const row = {
    tier: tier.key,
    name: tier.name,
    n: tier.n,
    target: tier.target,
    band: tier.band,
    samples: scores.length,
    clues: +mean(clueCounts).toFixed(1),
    min: scores[0],
    p25: q(scores, 0.25),
    p50: q(scores, 0.5),
    p75: q(scores, 0.75),
    p90: q(scores, 0.9),
    max: scores[scores.length - 1],
    steps: q(steps.sort((a, b) => a - b), 0.5),
    rounds: q(rounds.sort((a, b) => a - b), 0.5),
    depths: [...depths].sort((a, b) => a - b).join('/'),
    fill: inBand / Math.max(1, scores.length),
    ms50: +q(times, 0.5).toFixed(0),
    ms90: +q(times, 0.9).toFixed(0),
    scores,
    sampled,
    rej,
  };
  byTier.set(tier.key, row);
  rows.push(row);
  const cells = [row.n, row.target, row.clues, row.min, row.p25, row.p50, row.p75, row.p90, row.max, row.steps, row.rounds, row.depths, `${(100 * row.fill).toFixed(0)}%`, row.ms50, row.ms90];
  console.log('  ' + [tier.name, ...cells].map((v) => String(v).padStart(7)).join(' '));
}

// ---- gate 1: every tier lands in its own band --------------------------------------------
for (const r of rows) {
  check(r.fill >= BAND_FILL, `${r.tier}: 只有 ${(100 * r.fill).toFixed(0)}% 的样本落在自己的带 [${r.band}] 里（门槛 ${(100 * BAND_FILL).toFixed(0)}%）`);
  check(r.p50 >= r.band[0] && r.p50 <= r.band[1], `${r.tier}: 中位数 ${r.p50} 不在带 [${r.band}] 内`);
}

// ---- gate 2: the ladder actually climbs --------------------------------------------------
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1];
  const b = rows[i];
  check(b.p50 > a.p50, `阶梯断了：${a.name} 中位数 ${a.p50} 不小于 ${b.name} 的 ${b.p50}（前一档带 ${a.band}，后一档带 ${b.band}）`);
  check(b.band[0] >= a.band[0], `带的位置倒过来了：${b.name} 从 ${b.band[0]} 起，比 ${a.name} 的 ${a.band[0]} 还低`);
}
// the two order-4 rungs and the two order-5 rungs must differ by the clue knob, not by size
check(byTier.get('casual').clues < byTier.get('novice').clues, '上手档的线索数不比初学档少——target 这个轴没起作用');
check(byTier.get('sharp').clues < byTier.get('regular').clues, '高阶档的线索数不比熟练档少——target 这个轴没起作用');

// ---- side evidence: the answer set really is what makes the rules tick -------------------
// score is Σ weight × (a write, or a candidate erased), so a band moving without the clue count
// moving means something else drifted.
// `distribution(n)` is this engine's own count of "how many orderings of 1..n show exactly k towers",
// read off its permutation table. The same numbers fall out of the Stirling recurrence
// c(n,k) = c(n-1,k-1) + (n-1)·c(n-1,k) without enumerating anything, and Σ_k c(n,k) is n! — so this
// pins the table to a fact from outside the codebase. (A first draft of this line multiplied the row
// together instead of adding it, and spent a green build red: 6·11·6·1 is 396, never 24.)
const STIRLING = { 3: [2, 3, 1], 4: [6, 11, 6, 1], 5: [24, 50, 35, 10, 1], 6: [120, 274, 225, 85, 15, 1] };
for (const n of [3, 4, 5, 6]) {
  const d = distribution(n);
  const row = STIRLING[n];
  check(row.every((v, k) => d[k + 1] === v), `n=${n} 的可见数分布不是 Stirling 行 [${row}]，是 [${[...d].slice(1)}]`);
  const sum = [...d].slice(1).reduce((a, b) => a + b, 0);
  const fact = row.reduce((a, b) => a + b, 0);
  check(sum === fact, `n=${n}：分布之和 ${sum}，应等于 ${n}! = ${fact}`);
}

console.log('\n== 拒绝统计（每档 ${SAMPLES} 题造题时采样了多少个盘、按什么理由丢）=='.replace('${SAMPLES}', String(SAMPLES)));
for (const r of rows) {
  console.log(`  ${r.name}（${r.n} 阶）: 采样 ${r.sampled} 个盘，全线索就推不动而丢的 ${r.rej.ambiguous}`
    + `（${(100 * r.rej.ambiguous / Math.max(1, r.sampled)).toFixed(1)}%），删到 target=${r.target} 后推不动而丢的 ${r.rej.stalled}`);
}

console.log(`\n== 结论 ${failures.length ? `：${failures.length} 项未过（${elapsed()}）` : `：门禁全过（${elapsed()}）`} ==`);
for (const f of failures) console.log('  ✗ ' + f);
if (failures.length) process.exit(1);
