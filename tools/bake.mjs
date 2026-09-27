// Build-time bake: `js/data/levels.js` is written here and re-derived by `--check`.
//
//   node tools/bake.mjs           # write js/data/levels.js
//   node tools/bake.mjs --check   # fail if the file is not exactly what bake would write now
//
// Why a bake step at all, when the generator is deterministic and instant in the browser: a campaign
// row has to be a *measurement*, not a request. Once a level ships, the score printed under it is a
// fact about that board, and the menu must not be able to drift away from it. So each row carries the
// clue string and nothing else that matters — and `--check` recomputes every printed number from that
// string alone. If a printed 113.4 stops coming out of `solve()` on the baked clue set, the build
// goes red.
//
// `--check` therefore does two independent things:
//   1. SEMANTIC: for every row, rebuild the board from the clue string, run the pencil path, run
//      count.js's exhaustive counter, and compare score / step count / clue count / solution /
//      rule-depth / max candidate elimination against the printed numbers, cell by cell.
//   2. TEXTUAL: regenerate the file in memory and require it to be byte-identical to the one on
//      disk. No wall-clock time is printed anywhere for this to be possible (DESIGN.md §8).
//
// The `math` block is the one part that checks the engine against mathematics rather than against
// itself: the number of order-n lines showing exactly k towers is the unsigned Stirling number of
// the first kind c(n,k), computed here from the recurrence
//
//     c(n,k) = c(n-1,k-1) + (n-1)·c(n-1,k)
//
// which shares no code with `visible()` or with the permutation enumeration in js/engine/perm.js.
// The row counts Σ_k c(n,k) = n! and the number of Latin squares of order 4 (576) and order 5
// (161,280) are published constants, so countNaive's own leaf count is checked against them too.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NO_CLUE, createBoard, solve, verify, cluesFrom } from '../js/engine/skyscraper.js';
import { TIERS, makePuzzle, randomLatin, mix, PROOF_BUDGET } from '../js/engine/generate.js';
import { countSolutions, countNaive } from '../js/engine/count.js';
import { distribution, permTable } from '../js/engine/perm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'js', 'data', 'levels.js');
const CHECK = process.argv.includes('--check');

// Levels per chapter. Four is enough to show a tier's spread without making the bake (and every CI
// run of it) pay for another order-6 board each.
const PER_TIER = Number(process.env.LEVELS_PER_TIER || 4);
// countNaive enumerates every Latin square that matches the givens, with no clue pruning: order 4
// has 576 of them, order 5 has 161,280 (~60 ms here), order 6 has over a million per fixed first
// row. So the third, dumbest opinion is taken in full up to 5×5 and on the first row alone at 6×6.
const NAIVE_FULL = 5;
// The bake side of the uniqueness proof runs at the *same* ceiling the generator proved the board at
// (js/engine/generate.js's PROOF_BUDGET = 40,000,000 nodes, justified there by the measured 96-board
// order-6 census whose worst shipped proof cost 13,506,834). Cheaper here would be a weaker second
// opinion than the first: a board the generator proved in 13.5 M nodes would come back OVERBUDGET
// from this file and read as "not unique" — which is a false alarm, and false alarms get ignored.
const COUNT_BUDGET = Number(process.env.COUNT_BUDGET || PROOF_BUDGET);

const failures = [];
const check = (cond, message) => {
  if (!cond) failures.push(message);
  return !!cond;
};

// ---- clue-string codec, written independently of js/library.js --------------------------------
//
// library.js has its own decoder for this format. That duplication is the point: if the two
// disagree about which edge index is which, `--check`'s "rebuild the board from the string and
// re-solve it" step goes red instead of shipping 20 subtly wrong levels.

const NO_CLUE_CHAR = '.';

function encodeClue(clue) {
  let out = '';
  for (const v of clue) out += v === NO_CLUE ? NO_CLUE_CHAR : String(v);
  return out;
}

function decodeClue(n, text) {
  if (text.length !== 4 * n) throw new Error(`线索串长度 ${text.length}，应为 ${4 * n}`);
  const out = new Int8Array(4 * n);
  for (let i = 0; i < 4 * n; i++) out[i] = text[i] === NO_CLUE_CHAR ? NO_CLUE : Number(text[i]);
  return out;
}

const encodeGrid = (grid) => Array.from(grid, (v) => String(v)).join('');
const decodeGrid = (text) => Uint8Array.from(text, (ch) => Number(ch));

// ---- the campaign -----------------------------------------------------------------------------

const CHAPTER_TITLE = {
  novice: ['第一栋楼', '路边写满了数'],
  casual: ['往城里看', '边上少了一半数'],
  regular: '五阶的两个方向',
  sharp: '只剩排列集推得动',
  master: '六阶的 Hall 家族',
};

const levelName = (tier, j) => {
  const base = CHAPTER_TITLE[tier.key];
  if (Array.isArray(base)) return `${base[0]}·${['其一', '其二', '其三', '其四', '其五', '其六'][j] || `第${j + 1}关`}`;
  return `${base} 第${j + 1}关`;
};

// A tier's four boards: the first distinct clue sets this seed family produces that land inside the
// tier's own band. Seeds are literal so the same 20 boards come out on every machine.
//
// Every makePuzzle call below already carries the generator's own exhaustive-proof ledger (`p.proof`:
// how many candidate boards that seed handed to js/engine/count.js, how many came back UNIQUE, and
// how many were thrown out for OVERBUDGET / MANY / NONE / a cell-wise disagreement). It is tallied
// here per tier and printed by `--check` — this campaign was always re-proved after the fact by
// measure(), but the *seeds on the way to* a level used to be unproven, and the rate at which the
// prover refuses them is the number that says whether "unique" is being earned or assumed.
const PROOF_LEDGER = {};
const ledgerOf = (tier) => (PROOF_LEDGER[tier.key] ||= { calls: 0, handed: 0, proved: 0, unproven: 0, many: 0, none: 0, mismatch: 0, maxNodes: 0, puzzles: 0 });

function campaign(tier) {
  const rows = [];
  const seen = new Set();
  const led = ledgerOf(tier);
  for (let j = 0; rows.length < PER_TIER && j < PER_TIER * 12; j++) {
    const seed = `campaign|${tier.key}|${j}`;
    const p = makePuzzle(seed, tier.key);
    if (!p) throw new Error(`${tier.key}: 种子 ${seed} 造不出盘（生成器或阶梯需要重看）`);
    led.calls++;
    if (p.proof) {
      led.handed += p.proof.handed;
      led.proved += p.proof.proved;
      led.unproven += p.rejected.unproven;
      led.many += p.rejected.many;
      led.none += p.rejected.none;
      led.mismatch += p.rejected.mismatch;
      if (p.proof.maxNodes > led.maxNodes) led.maxNodes = p.proof.maxNodes;
    }
    if (p.score < tier.band[0] || p.score > tier.band[1]) continue;
    const key = encodeClue(p.board.clue);
    if (seen.has(key)) continue;
    seen.add(key);
    led.puzzles++;
    const s = solve(p.board);
    const c = countSolutions(p.board, { cap: 2, budget: COUNT_BUDGET });
    const naive = p.n <= NAIVE_FULL
      ? countNaive(p.board, { cap: 2 })
      : countNaive(p.board, { cap: 2, given: firstRowGivens(p.n, s.derived) });
    const rules = Object.entries(s.breakdown).sort((a, b) => b[1] - a[1]);
    rows.push({
      id: `${tier.key[0].toUpperCase()}${String(rows.length + 1).padStart(2, '0')}-${tier.key}`,
      name: levelName(tier, rows.length),
      tier: tier.key,
      n: p.n,
      clue: key,
      solution: encodeGrid(s.derived),
      seed,
      // every printed number below is recomputed from `clue` by measure()
      score: s.score,
      steps: s.steps,
      places: s.places,
      prunes: s.prunes,
      eliminated: s.eliminated,
      rounds: s.rounds,
      clues: p.board.clues,
      depth: s.depth,
      topRule: rules.length ? rules[0][0] : '',
      unique: c.status === 'UNIQUE',
      naiveOne: naive.solutions === 1,
    });
  }
  if (rows.length !== PER_TIER) {
    throw new Error(`${tier.key}: 只凑出 ${rows.length}/${PER_TIER} 关落在带 [${tier.band}] 里`);
  }
  return rows;
}

const firstRowGivens = (n, grid) => {
  const given = new Uint8Array(n * n);
  for (let c = 0; c < n; c++) given[c] = grid[c];
  return given;
};

// ---- re-measure a baked row from its clue string alone -----------------------------------------

function measure(row) {
  const board = createBoard({ n: row.n, clue: decodeClue(row.n, row.clue) });
  const s = solve(board);
  const c = countSolutions(board, { cap: 2, budget: COUNT_BUDGET });
  const naive = row.n <= NAIVE_FULL
    ? countNaive(board, { cap: 2 })
    : countNaive(board, { cap: 2, given: firstRowGivens(row.n, s.derived) });
  const rules = Object.entries(s.breakdown).sort((a, b) => b[1] - a[1]);
  return {
    ok: s.ok,
    score: s.score,
    steps: s.steps,
    places: s.places,
    prunes: s.prunes,
    eliminated: s.eliminated,
    rounds: s.rounds,
    clues: board.clues,
    depth: s.depth,
    topRule: rules.length ? rules[0][0] : '',
    solution: encodeGrid(s.derived),
    unique: c.status === 'UNIQUE',
    uniqueCellwise: c.status === 'UNIQUE' && Array.from(c.first).join(',') === Array.from(s.derived).join(','),
    naiveOne: naive.solutions === 1,
    naiveSame: !!naive.first && Array.from(naive.first).join(',') === Array.from(s.derived).join(','),
    accepted: verify(board, s.derived).length === 0,
    clueRoundTrip: encodeClue(board.clue) === row.clue,
  };
}

function verifyRow(row, where) {
  const m = measure(row);
  const eqFields = ['score', 'steps', 'places', 'prunes', 'eliminated', 'rounds', 'clues', 'depth', 'solution'];
  for (const f of eqFields) {
    check(String(row[f]) === String(m[f]), `${where} ${row.id}: 印着 ${f}=${row[f]}，从线索串重算是 ${m[f]}`);
  }
  check(row.topRule === m.topRule, `${where} ${row.id}: 印着最多用到的规则 ${row.topRule}，重算是 ${m.topRule}`);
  check(m.ok, `${where} ${row.id}: 铅笔路径推不到底了，这一关不该出货`);
  check(m.accepted, `${where} ${row.id}: 推出来的盘通不过独立验收 verify()`);
  check(m.unique && m.uniqueCellwise, `${where} ${row.id}: 穷举计数器不再判 UNIQUE（或与铅笔路径逐格不一致）`);
  check(m.naiveOne && m.naiveSame, `${where} ${row.id}: 朴素枚举这一路不认这个答案`);
  check(m.clueRoundTrip, `${where} ${row.id}: 线索串解码后再编码不等于原文（两条解码路径漂移了）`);
  const grid = decodeGrid(row.solution);
  const printed = decodeClue(row.n, row.clue);
  const fromAnswer = cluesFrom(row.n, grid);
  for (let i = 0; i < printed.length; i++) {
    check(
      printed[i] === NO_CLUE || printed[i] === fromAnswer[i],
      `${where} ${row.id}: 第 ${i + 1} 条边印着 ${printed[i]}，可答案串在那条边上数出来是 ${fromAnswer[i]}——线索和答案对不上`,
    );
  }
  return m;
}

// ---- the math block: the engine checked against published numbers -------------------------------

// Unsigned Stirling numbers of the first kind, from the recurrence — no towers, no permutations.
function stirlingRow(n) {
  const c = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
  c[0][0] = 1;
  for (let i = 1; i <= n; i++) for (let k = 1; k <= i; k++) c[i][k] = c[i - 1][k - 1] + (i - 1) * c[i - 1][k];
  return c[n].slice(1);
}

// Σ_k c(n,k) = n! is the identity that ties the recurrence to the permutation table.
function factorial(n) {
  let x = 1;
  for (let i = 2; i <= n; i++) x *= i;
  return x;
}

const LATIN_COUNTS = { 3: 12, 4: 576, 5: 161280 };

function measureMath() {
  const stirling = {};
  const perms = {};
  for (const n of [4, 5, 6]) {
    const row = stirlingRow(n);
    const dist = Array.from(distribution(n)).slice(1);
    stirling[n] = row;
    perms[n] = dist;
    check(
      JSON.stringify(row) === JSON.stringify(dist),
      `${n} 阶的可见数分布枚举出 ${JSON.stringify(dist)}，Stirling 递推给出 ${JSON.stringify(row)}——visible() 或排列表错了`,
    );
    check(dist.reduce((a, b) => a + b, 0) === factorial(n), `${n} 阶排列表行数是 ${dist.reduce((a, b) => a + b, 0)}，应为 ${factorial(n)}`);
    check(permTable(n).count === factorial(n), `${n} 阶 permTable().count=${permTable(n).count}，应为 ${factorial(n)}`);
    check(row[n - 1] === 1, `${n} 阶只有一种摆法能看见全部 ${n} 栋（升序），递推算出 ${row[n - 1]}`);
    check(row[0] === factorial(n - 1), `${n} 阶「只看见一栋」应是第一格站 ${n} 楼，即 ${(n - 1)}! = ${factorial(n - 1)} 种，递推给出 ${row[0]}`);
  }
  // countNaive's leaf count on a board whose clues it can barely use is the Latin-square count.
  const latin = {};
  for (const n of [3, 4, 5]) {
    const grid = randomLatin(n, mix(`latin-${n}`));
    const board = createBoard({ n, clue: cluesFrom(n, grid) });
    const naive = countNaive(board, { cap: Infinity });
    latin[n] = naive.checked;
    check(
      naive.checked === LATIN_COUNTS[n],
      `${n} 阶朴素枚举访问了 ${naive.checked} 个拉丁方，公开常数是 ${LATIN_COUNTS[n]}——countNaive 漏了或重了`,
    );
  }
  // 6×6 with its first row pinned: 9,408 reduced Latin squares × 5! ways to complete them.
  const six = { fixedFirstRow: 9408 * factorial(5) };
  {
    const grid = randomLatin(6, mix('latin-6'));
    const board = createBoard({ n: 6, clue: cluesFrom(6, grid) });
    const naive = countNaive(board, { cap: Infinity, given: firstRowGivens(6, Uint8Array.from(grid)) });
    check(
      naive.checked === six.fixedFirstRow,
      `6 阶固定首行后枚举到 ${naive.checked} 个拉丁方，应为 9408×5! = ${six.fixedFirstRow}（9408 是 6 阶化拉丁方的公开数）`,
    );
  }
  return { stirling, perms, latin, latinSource: 'OEIS/公开常数：3 阶 12、4 阶 576、5 阶 161280、6 阶化 9408', six };
}

// ---- the file ----------------------------------------------------------------------------------

function tiersMeta(rowsByTier) {
  const out = {};
  for (const tier of TIERS) {
    const rows = rowsByTier[tier.key];
    out[tier.key] = {
      name: tier.name,
      n: tier.n,
      size: `${tier.n}×${tier.n}`,
      band: tier.band,
      target: tier.target,
      tries: tier.tries,
      levels: rows.length,
      clueLo: Math.min(...rows.map((r) => r.clues)),
      clueHi: Math.max(...rows.map((r) => r.clues)),
      scoreLo: Math.min(...rows.map((r) => r.score)),
      scoreHi: Math.max(...rows.map((r) => r.score)),
      stepsLo: Math.min(...rows.map((r) => r.steps)),
      stepsHi: Math.max(...rows.map((r) => r.steps)),
      deepest: Math.max(...rows.map((r) => r.depth)),
    };
  }
  return out;
}

const lit = (v) => JSON.stringify(v, null, 2);

// Fixed field list and fixed order: the textual half of `--check` compares bytes, so the emitted
// shape must not depend on what object literal happened to be written first. `unique` / `naiveOne`
// are deliberately *not* printed — they are verdicts `--check` re-renders, not measurements.
const ROW_FIELDS = [
  'id', 'name', 'tier', 'n', 'clue', 'solution', 'seed',
  'score', 'steps', 'places', 'prunes', 'eliminated', 'rounds', 'clues', 'depth', 'topRule',
];

function render(LEVELS, PROOF, META) {
  const pick = (r) => ROW_FIELDS.reduce((o, k) => ((o[k] = r[k]), o), {});
  const L = LEVELS.map((r) => '  ' + lit(pick(r)).replace(/\n/g, '\n  ')).join(',\n');
  return `// js/data/levels.js — generated by tools/bake.mjs. Do not edit by hand.
//
// A row here is a measurement, not a request: every number after \`solution\` is recomputed from
// \`clue\` by \`node tools/bake.mjs --check\`, which fails the build when a printed figure stops
// following from the board it is printed under. The clue string is 4n characters, one per edge in
// the order 上/右/下/左 × 1..n, \`.\` for an edge with nothing printed on it.

export const LEVELS = [
${L},
];

export const PROOF = ${lit(PROOF)};

export const TIERS_META = ${lit(META)};
`;
}

function printLedger(where) {
  console.log(`\n  ${where}：每档 X/N 逐档列，聚合起来的一个数藏住了是哪一档在撞预算`);
  console.log('    档位      走到的种子  入盘关卡  交给穷举的候选盘  证完  没数完  多解  无解  逐格不一致   拒绝率 X/N   最贵一次证明');
  for (const tier of TIERS) {
    const l = PROOF_LEDGER[tier.key] || { calls: 0, handed: 0, proved: 0, unproven: 0, many: 0, none: 0, mismatch: 0, maxNodes: 0, puzzles: 0 };
    const rej = l.unproven + l.many + l.none + l.mismatch;
    check(l.handed === l.proved + rej, `${tier.key}: 穷举器记账不平（交给 ${l.handed} ≠ 证完 ${l.proved} + 拒绝 ${rej}）`);
    check(l.handed > 0, `${tier.key}: 这一档一颗候选盘都没交给独立穷举器，"唯一解"没有证据`);
    check(l.maxNodes < COUNT_BUDGET, `${tier.key}: 最贵一次证明 ${l.maxNodes} 节点已经贴到预算 ${COUNT_BUDGET} 的顶`);
    console.log(`    ${tier.name.padEnd(6)}${String(l.calls).padStart(9)} ${String(l.puzzles).padStart(7)}  ${String(l.handed).padStart(15)}`
      + ` ${String(l.proved).padStart(6)} ${String(l.unproven).padStart(6)} ${String(l.many).padStart(5)} ${String(l.none).padStart(4)} ${String(l.mismatch).padStart(9)}`
      + `   ${`${rej}/${l.handed}`.padStart(8)} ${String(l.maxNodes).padStart(13)}`);
  }
}

function build() {
  const rowsByTier = {};
  const LEVELS = [];
  for (const tier of TIERS) {
    rowsByTier[tier.key] = campaign(tier);
    LEVELS.push(...rowsByTier[tier.key]);
  }
  const math = measureMath();
  const PROOF = {
    math,
    tiers: {},
    totals: {
      levels: LEVELS.length,
      unique: 0,
      finished: 0,
      naiveAgree: 0,
    },
  };
  for (const tier of TIERS) {
    const rows = rowsByTier[tier.key];
    PROOF.tiers[tier.key] = {
      n: tier.n,
      band: tier.band,
      levels: rows.length,
      scores: rows.map((r) => r.score),
      clues: rows.map((r) => r.clues),
      steps: rows.map((r) => r.steps),
      deepest: Math.max(...rows.map((r) => r.depth)),
    };
    PROOF.totals.unique += rows.filter((r) => r.unique).length;
    PROOF.totals.finished += rows.filter((r) => solve(createBoard({ n: r.n, clue: decodeClue(r.n, r.clue) })).ok).length;
    PROOF.totals.naiveAgree += rows.filter((r) => r.naiveOne).length;
  }
  const text = render(LEVELS, PROOF, tiersMeta(rowsByTier));
  return { LEVELS, PROOF, text };
}

// ---- run --------------------------------------------------------------------------------------

const { LEVELS, PROOF, text } = build();

if (CHECK) {
  console.log(`== bake --check：${LEVELS.length} 关，每个印出的数字都从线索串重算 ==`);
  let i = 0;
  for (const row of LEVELS) {
    i++;
    const m = verifyRow(row, `第 ${i} 关`);
    console.log(`  ${row.id} ${row.n}×${row.n} 线索 ${m.clues} 分 ${m.score} 步 ${m.steps} 深度 ${m.depth} 唯一 ${m.unique ? '✓' : '✗'} 穷举同解 ${m.uniqueCellwise ? '✓' : '✗'} 朴素 ${m.naiveOne && m.naiveSame ? '✓' : '✗'}`);
  }
  const onDisk = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  check(onDisk === text, onDisk ? 'js/data/levels.js 与 bake 现在要写出的内容不一致（跑一次 npm run bake 再提交）' : 'js/data/levels.js 不存在，跑 npm run bake');
  printLedger('--check：出题侧独立穷举证明的账（OVERBUDGET 记为拒绝，绝不记为通过）');
  console.log(`\n  数学对照：可见数分布 = 第一类 Stirling 数；拉丁方数 ${JSON.stringify(PROOF.math.latin)}；6 阶定首行 ${PROOF.math.six.fixedFirstRow} 个`);
  console.log(`  总计：${PROOF.totals.levels} 关，出货时唯一解 ${PROOF.totals.unique}，铅笔推到底 ${PROOF.totals.finished}，朴素枚举同判 ${PROOF.totals.naiveAgree}`);
  console.log(failures.length ? `\n== bake --check 失败：${failures.length} 处 ==\n` + failures.map((f) => '  ✗ ' + f).join('\n') : `\n== bake --check 全过：印出的每个数字都从线索串重算出来了 ==`);
  if (failures.length) process.exit(1);
  process.exit(0);
}

if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
const before = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
fs.writeFileSync(OUT, text);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${LEVELS.length} 关 / ${text.length} 字节 ${before ? '(覆写)' : '(新建)'}`);
printLedger('出题侧独立穷举证明的账（每档 X/N）');
for (const tier of TIERS) {
  const rows = LEVELS.filter((r) => r.tier === tier.key);
  console.log(`  ${tier.name}（${tier.n}×${tier.n}）: ${rows.map((r) => `${r.score}分/${r.clues}线索`).join('  ')}`);
}
