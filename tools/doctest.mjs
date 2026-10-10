// 文档数字闸：README / DESIGN 里印出去的每一个「现值」都必须等于代码现在的值，或者等于本文件
// 当场从引擎重算出来的读数。
//
// 为什么要有这个文件：引擎断言、出厂重算、浏览器文案都有命令去复测，而散文没有。它可以一直抄下去，
// 直到某天代码改了字、文档还在引用上一个世界的数。本仓 README 自己写着「代码 > 本文档」，这一条
// 就是那句声明的执行器。
//
// 规矩（照 z-biz-game-kurotto-cos / ferry / minishop 的机制）：
//   * 每一条等式都配一条「解析到的条数」的反空转断言——正则没命中不是绿，是红；
//   * 现值（TIERS / band / target / 预算 / 哨兵 / 端口 / 夹具）与**重算读数**（分数、中位、节点数、
//     开火普查、墙探针）都重算，不抄：出厂 20 关的数字从 `clue` 串重解，现场 24 题从 `balance-<档>-<k>`
//     种子重造，穷举那一票打在 `countSolutions` / `countNaive` 上，**不读 levels.js 里记着的答案**
//     （生成器自己记的数在剪线索之后就不作数了——本农场反复踩过这一脚）；
//   * 墙钟数（ms、秒）在这里一条都不重测，也不新写：本文件只在文档把「计时」误当「现值」时红
//     （见 D12），读数本身留在 README/DESIGN 的原地，出处与方向已写明；
//   * 文档改形状（表格列、句子措辞、引用格式）不算通过的理由：解析不到就是红。
//
//   node tools/doctest.mjs              全跑（约 25 s：一次 engine-test + 出厂/现场两批重算）
//   node tools/doctest.mjs --quiet      只打红行与合计
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createBoard, cluesFrom, solve, rulesUsed, RULE_LIST, EMPTY, SIDES, clueIndex } from '../js/engine/skyscraper.js';
import { countSolutions, countNaive, UNIQUE } from '../js/engine/count.js';
import { TIERS, makePuzzle, randomLatin, mix, PROOF_BUDGET } from '../js/engine/generate.js';
import { MAX_N, NO_CLUE, distribution } from '../js/engine/perm.js';
import { LEVELS, boardOfRow, puzzleFromTier, dailyPuzzle, decodeGrid, encodeClue } from '../js/library.js';
import { KEY as SAVE_KEY } from '../js/store.js';
import { Cell } from '../js/theme.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const QUIET = process.argv.includes('--quiet');
const fail = [];
const emitted = new Set();
let rows = 0;
const ok = (cond, label, detail) => {
  rows++;
  emitted.add(label.match(/^D\d+/)[0]);
  if (!cond) fail.push(label);
  if (!QUIET || !cond) console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label} · ${detail}`);
};
const num = (s) => Number(String(s).replace(/[*,\s]/g, ''));
// 与 tools/balance.mjs:43 的 q() 同一个口径（README 的「本页所有中位/p50 都取 sorted[floor(n/2)]」）
const q = (list, p) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const round1 = (x) => +x.toFixed(1);

const README = read('README.md');
const DESIGN = read('DESIGN.md');
const DOCS = README + '\n' + DESIGN;
const CI = read('.github/workflows/ci.yml');
const PKG = JSON.parse(read('package.json'));
const VERIFY = read('tools/verify.sh');
const BAL = read('tools/balance.mjs');
const BAKE = read('tools/bake.mjs');
const ENGTEST = read('tools/engine-test.mjs');
const SCEN = read('tools/scenarios.js');
const PLAYTEST = read('tools/playtest.cjs');
const LIB = read('js/library.js');
const HTML = read('index.html');
const CSS = read('css/game.css');

// ---- 重算：出厂 20 关（只认 clue 串，不认 levels.js 里印着的读数）---------------------------
// 独立穷举器与朴素枚举在这里就是「第二个意见」：`唯一解 20` 这句话由它们投，而不是由生成器记的那一份。
const NAIVE_FULL = 5;
const firstRow = (n, grid) => {
  const given = new Uint8Array(n * n);
  for (let c = 0; c < n; c++) given[c] = grid[c];
  return given;
};
const shipped = [];
for (const row of LEVELS) {
  const board = boardOfRow(row);
  const s = solve(board);
  const c = countSolutions(board, { cap: 2, budget: 4000000 });
  const naive = row.n <= NAIVE_FULL
    ? countNaive(board, { cap: 2 })
    : countNaive(board, { cap: 2, given: firstRow(row.n, s.derived) });
  shipped.push({ row, board, s, c, naive });
}
const byTier = new Map(TIERS.map((t) => [t.key, shipped.filter((x) => x.row.tier === t.key)]));

// ---- 重算：现场 24 题/档（balance 的种子族，逐项自己算分位，不跑 balance 的嘴）--------------
const SAMPLES_DOC = 24;
const live = new Map();
for (const t of TIERS) {
  const scores = [];
  const steps = [];
  const depths = [];
  const nodesAt4M = [];
  let inBand = 0;
  let sampled = 0;
  const rej = { ambiguous: 0, stalled: 0, unproven: 0, many: 0, none: 0, mismatch: 0 };
  const gen = { handed: 0, proved: 0, maxNodes: 0, maxPuzzleNodes: 0, puzzles: 0 };
  for (let k = 0; k < SAMPLES_DOC; k++) {
    const p = makePuzzle(`balance-${t.key}-${k}`, t.key);
    if (!p) { scores.push(NaN); continue; }
    scores.push(p.score);
    steps.push(p.steps);
    const s = solve(p.board);
    depths.push(s.depth);
    nodesAt4M.push(countSolutions(p.board, { cap: 2, budget: 4000000 }).nodes);
    if (p.score >= t.band[0] && p.score <= t.band[1]) inBand++;
    sampled += p.sampled || 0;
    for (const key of Object.keys(rej)) rej[key] += (p.rejected && p.rejected[key]) || 0;
    if (p.proof) {
      gen.puzzles++;
      gen.handed += p.proof.handed;
      gen.proved += p.proof.proved;
      if (p.proof.maxNodes > gen.maxNodes) gen.maxNodes = p.proof.maxNodes;
      if (p.proof.nodes > gen.maxPuzzleNodes) gen.maxPuzzleNodes = p.proof.nodes;
    }
  }
  live.set(t.key, { scores, steps, depths, nodesAt4M, inBand, sampled, rej, gen });
}

// ---- 重算：全线索墙（4n 条边全印上，铅笔路径能不能推完）------------------------------------
const WALL = 120;
const wall = new Map();
for (const n of [4, 5, 6, 7]) {
  let okc = 0;
  let tried = 0;
  for (let k = 0; k < WALL; k++) {
    const g = randomLatin(n, mix(`wall-${n}-${k}`));
    if (!g) continue;
    tried++;
    let board;
    try { board = createBoard({ n, clue: cluesFrom(n, g) }); } catch { continue; }
    if (solve(board).ok) okc++;
  }
  wall.set(n, { ok: okc, tried });
}

// ---- 重算：规则开火普查（出厂 20 关逐步归类，探针 D 的口径）--------------------------------
const fired = new Map();
const perTierKind = new Map();
let censusSteps = 0;
let censusDepth = 0;
for (const x of shipped) {
  const use = rulesUsed(x.s.rows);
  for (const [k, v] of Object.entries(use)) fired.set(k, (fired.get(k) || 0) + v);
  const pt = perTierKind.get(x.row.tier) || new Set();
  for (const k of Object.keys(use)) pt.add(k);
  perTierKind.set(x.row.tier, pt);
  censusSteps += x.s.rows.length;
  if (x.s.depth > censusDepth) censusDepth = x.s.depth;
}
const silentRules = RULE_LIST.map((r) => r.name).filter((n) => !fired.has(n));
const firedSorted = [...fired.entries()].sort((a, b) => b[1] - a[1]);

// ---- D1 五档阶梯表：文档那 10 列逐格等于 TIERS 现值 + 重算读数 ------------------------------
// 表头（README 第 47 行）：档 | 阶 | target | band | 出厂 4 关实测分数 | 出厂分数中位 | 现场 p50 |
//                          现场 min–max | 步数中位（出厂／现场） | 规则深度上限
const tierRowRe = /^\| (\S+) (\w+) \| (\d+) \| (\d+) \| \[(\d+), (\d+)\] \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| (\d+) \|$/gm;
const tierRows = [...README.matchAll(tierRowRe)];
ok(tierRows.length === TIERS.length, `D1a README 的档位表解析到 ${TIERS.length} 行（解析不到不是绿）`,
  `解析 ${tierRows.length} 行 vs TIERS ${TIERS.length} 档`);
const tierHeader = (README.match(/^\| 档 \| 阶 \|(.*)\|$/m) || [])[1] || '';
const headerCells = tierHeader.split('|').map((x) => x.trim()).filter(Boolean);
ok(headerCells.length === 8, `D1b 档位表的表头解析到 8 个非首列（列形改了这里就红，别拿"表格换了写法"当理由）`,
  `${headerCells.length} 列：${headerCells.join(' / ')}`);
for (const t of TIERS) {
  const row = tierRows.find((m) => m[2] === t.key);
  ok(!!row, `D1 ${t.key} 那一档在文档的档位表里有一行`, row ? `| ${row[1]} ${row[2]} |` : '文档里没有这一档');
  if (!row) continue;
  const g = (i) => String(row[i]).trim();
  ok(row[1] === t.name, `D1c ${t.key} 的中文档名等于 TIERS 现值 ${t.name}`, `文档「${row[1]}」vs 代码「${t.name}」`);
  ok(+g(3) === t.n, `D1 ${t.key} 的阶等于 TIERS 现值 ${t.n}`, `文档 ${g(3)} vs 代码 ${t.n}`);
  ok(+g(4) === t.target, `D1 ${t.key} 的 target 等于 TIERS 现值 ${t.target}`, `文档 ${g(4)} vs 代码 ${t.target}`);
  ok(+g(5) === t.band[0] && +g(6) === t.band[1], `D1 ${t.key} 的 band 等于 TIERS 现值 [${t.band}]`,
    `文档 [${g(5)}, ${g(6)}] vs 代码 [${t.band}]`);
  const xs = byTier.get(t.key);
  const docScores = g(7).split('/').map((x) => num(x));
  const realScores = xs.map((x) => x.s.score);
  ok(docScores.length === xs.length && docScores.every((v, i) => v === realScores[i]),
    `D1d ${t.key} 出厂 4 关的分数逐格 = 从 clue 串重算的 score（不读 levels.js 印着的那一列）`,
    `文档 ${docScores.join('/')} vs 重算 ${realScores.join('/')}`);
  ok(num(g(8)) === q(realScores, 0.5), `D1e ${t.key} 出厂分数中位 = 重算分数按 q() 口径的中位 ${q(realScores, 0.5)}`,
    `文档 ${g(8)} vs 重算 ${q(realScores, 0.5)}`);
  const L = live.get(t.key);
  ok(round1(q(L.scores, 0.5)) === num(g(9)), `D1f ${t.key} 现场 ${SAMPLES_DOC} 题 p50 = 重造的 ${round1(q(L.scores, 0.5))}`,
    `文档 ${g(9)} vs 重算 ${round1(q(L.scores, 0.5))}`);
  const mm = g(10).split(/[–-]/).map((x) => num(x.trim()));
  ok(mm.length === 2 && mm[0] === round1(Math.min(...L.scores)) && mm[1] === round1(Math.max(...L.scores)),
    `D1g ${t.key} 现场 min–max = 重算的 ${round1(Math.min(...L.scores))} – ${round1(Math.max(...L.scores))}`,
    `文档 ${g(10)} vs 重算 ${round1(Math.min(...L.scores))} – ${round1(Math.max(...L.scores))}`);
  const st = g(11).split('/').map((x) => num(x.trim()));
  ok(st.length === 2 && st[0] === q(xs.map((x) => x.s.steps), 0.5) && st[1] === q(L.steps, 0.5),
    `D1 ${t.key} 步数中位（出厂／现场）= 重算的 ${q(xs.map((x) => x.s.steps), 0.5)} / ${q(L.steps, 0.5)}`,
    `文档 ${g(11)} vs 重算 ${q(xs.map((x) => x.s.steps), 0.5)} / ${q(L.steps, 0.5)}`);
  ok(+g(12) === Math.max(...xs.map((x) => x.s.depth), ...L.depths),
    `D1 ${t.key} 规则深度上限 = 两批重算里的最大 depth ${Math.max(...xs.map((x) => x.s.depth), ...L.depths)}`,
    `文档 ${g(12)} vs 重算 ${Math.max(...xs.map((x) => x.s.depth), ...L.depths)}`);
}

// ---- D2 阶梯的两条整体承诺：入带率、中位严格递增 --------------------------------------------
const fillLine = README.match(/五档入带率 \*\*(\d+)%\*\*（(\d+)\/(\d+) 全部落在自己的带里），中位数严格递增：([\d.]+ < [\d.]+ < [\d.]+ < [\d.]+ < [\d.]+)/);
ok(!!fillLine, 'D2a README 那句「五档入带率 + 中位数严格递增」解析到了（解析不到就是表格改了形状）',
  fillLine ? `文档 ${fillLine[1]}%（${fillLine[2]}/${fillLine[3]}）` : '解析不到');
const allInBand = TIERS.every((t) => live.get(t.key).inBand === live.get(t.key).scores.length);
ok(!!fillLine && +fillLine[1] === 100 && allInBand, 'D2 五档入带率重算就是 100%（每档 24/24 落在自己的带里）',
  TIERS.map((t) => `${t.key} ${live.get(t.key).inBand}/${live.get(t.key).scores.length}`).join(' '));
ok(!!fillLine && +fillLine[2] === SAMPLES_DOC && +fillLine[3] === SAMPLES_DOC,
  `D2b 入带率的分母是文档写的那个样本数 ${SAMPLES_DOC}`, `文档 ${fillLine?.[2]}/${fillLine?.[3]} vs ${SAMPLES_DOC}`);
const docMeds = fillLine ? fillLine[4].split(' < ').map((x) => +x) : [];
const liveMeds = TIERS.map((t) => round1(q(live.get(t.key).scores, 0.5)));
ok(docMeds.length === TIERS.length && docMeds.join(',') === liveMeds.join(',') &&
  liveMeds.every((v, i) => i === 0 || v > liveMeds[i - 1]),
  `D2 中位数链逐格等于重算的现场中位且严格递增（${liveMeds.join(' < ')}）`,
  `文档 ${docMeds.join(' < ')} vs 重算 ${liveMeds.join(' < ')}`);
const introP50 = README.match(/现场 p50 仍是 ([\d. /]+)/);
ok(!!introP50 && introP50[1].trim().split(/\s*\/\s*/).map(Number).join(',') === liveMeds.join(','),
  'D2c README 开头那句「现场 p50 仍是 …」也等于重算的现场中位（同一件事不许有两个数）',
  introP50 ? `文档 ${introP50[1].trim()}` : '解析不到那句');

// ---- D3 拒绝统计与穷举举证台账 -------------------------------------------------------------
const rejRows = [...README.matchAll(/^- 五档现场抽题[\s\S]*?\n((?:  [^-\n]+\n)+)/gm)];
ok(rejRows.length === 1, 'D3a README 的 reject 那一段解析到一段（解析不到就是列表改了形状）', `${rejRows.length} 段`);
const rejClaims = [...(rejRows[0] ? rejRows[0][1] : '').matchAll(/([一-龥]+) (\d+)\/(\d+)（([\d.]+)%）/g)];
ok(rejClaims.length === TIERS.length, `D3b reject 那一行解析到 ${TIERS.length} 档的丢弃计数`,
  `解析 ${rejClaims.length} 条：${rejClaims.map((m) => m[1]).join(' ') || '无'}`);
for (const m of rejClaims) {
  const t = TIERS.find((x) => x.name === m[1]);
  const L = t && live.get(t.key);
  ok(!!t && L.sampled === +m[3] && L.rej.ambiguous === +m[2],
    `D3 ${m[1]} 的「全线索推不动而丢 ${m[2]}／采样 ${m[3]}」逐格等于重造的题`,
    t ? `文档 ${m[2]}/${m[3]} vs 重算 ${L.rej.ambiguous}/${L.sampled}` : '代码里没有这一档');
  ok(!!t && +m[4] === round1(100 * L.rej.ambiguous / L.sampled),
    `D3 ${m[1]} 的百分比 ${m[4]}% 等于重算的 ${t ? round1(100 * L.rej.ambiguous / L.sampled) : '?'}%`,
    t ? `文档 ${m[4]}% vs 重算 ${round1(100 * L.rej.ambiguous / L.sampled)}%` : '代码里没有这一档');
}
ok(TIERS.every((t) => live.get(t.key).rej.stalled === 0),
  'D3c「删到 target 之后推不动而丢」五档重算全是 0（README 与 DESIGN 都这么承诺）',
  TIERS.map((t) => `${t.key} ${live.get(t.key).rej.stalled}`).join(' '));
const ledgerRows = [...README.matchAll(/^\| (初学|上手|熟练|高阶|大师) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| ([\d,*]+) \| ([\d,*]+) \|$/gm)];
ok(ledgerRows.length === TIERS.length, `D3d README 的穷举举证台账解析到 ${TIERS.length} 行`,
  `解析 ${ledgerRows.length} 行`);
for (const m of ledgerRows) {
  const t = TIERS.find((x) => x.name === m[1]);
  const L = t && live.get(t.key);
  ok(!!t && +m[2] === SAMPLES_DOC && L.gen.puzzles === SAMPLES_DOC,
    `D3 ${m[1]} 台账的「出货 ${m[2]}」= 重算的出盘数 ${L ? L.gen.puzzles : '?'}（${SAMPLES_DOC} 题口径）`,
    t ? `文档 ${m[2]} vs 重算 ${L.gen.puzzles}` : '代码里没有这一档');
  ok(!!t && +m[3] === L.gen.handed, `D3 ${m[1]} 交给穷举 ${m[3]} 张 = 重算的 proof.handed`,
    t ? `文档 ${m[3]} vs 重算 ${L.gen.handed}` : '代码里没有这一档');
  ok(!!t && +m[4] === L.gen.proved && L.gen.proved === L.gen.handed - L.rej.unproven - L.rej.many - L.rej.none - L.rej.mismatch,
    `D3 ${m[1]} 证完 ${m[4]} 张 = 重算的 proof.proved，且账平（交给 = 证完 + 四类拒绝）`,
    t ? `文档 ${m[4]} vs 重算 ${L.gen.proved}（拒绝 ${L.rej.unproven + L.rej.many + L.rej.none + L.rej.mismatch}）` : '代码里没有这一档');
  ok(!!t && [+m[5], +m[6], +m[7], +m[8]].join(',') === [L.rej.unproven, L.rej.many, L.rej.none, L.rej.mismatch].join(','),
    `D3 ${m[1]} 的四类拒绝 ${m[5]}/${m[6]}/${m[7]}/${m[8]} 逐格等于重算`,
    t ? `文档 ${m[5]}/${m[6]}/${m[7]}/${m[8]} vs 重算 ${[L.rej.unproven, L.rej.many, L.rej.none, L.rej.mismatch].join('/')}` : '代码里没有这一档');
  ok(!!t && num(m[9]) === L.gen.maxNodes, `D3 ${m[1]} 最贵一次证明 ${m[9]} 节点 = 重算的 proof.maxNodes`,
    t ? `文档 ${m[9]} vs 重算 ${L.gen.maxNodes}` : '代码里没有这一档');
  ok(!!t && num(m[10]) === L.gen.maxPuzzleNodes, `D3 ${m[1]} 单题最贵合计 ${m[10]} 节点 = 重算的 max(proof.nodes)`,
    t ? `文档 ${m[10]} vs 重算 ${L.gen.maxPuzzleNodes}` : '代码里没有这一档');
}
const handedSum = TIERS.reduce((a, t) => a + live.get(t.key).gen.handed, 0);
const sumClaim = README.match(/本轮 (\d+) 张候选盘（([\d+]+)）/);
ok(!!sumClaim && +sumClaim[1] === handedSum && sumClaim[2].split('+').map(Number).reduce((a, b) => a + b, 0) === handedSum,
  `D3e「本轮 N 张候选盘」等于台账那一列加起来的 ${handedSum}`,
  sumClaim ? `文档 ${sumClaim[1]}（${sumClaim[2]}）vs 重算 ${handedSum}` : '解析不到那句');
const worst = Math.max(...TIERS.map((t) => live.get(t.key).gen.maxNodes));
ok(/节点是 `balance` 用的 [\d,]+ 预算的 [\d.]+%、是出题预算 [\d,]+ 的 [\d.]+%/.test(README),
  'D3f 文档那句「最贵一次证明占两个预算的百分比」还在（解析不到就是这句话被改了形状）',
  README.match(/大师档 [\d,]+ 节点是 `balance` 用的/) ? '在' : '不在');
{
  const m = [...DOCS.matchAll(/([\d,]+) 节点是 `balance` 用的 ([\d,]+) 预算的 ([\d.]+)%、是出题预算 ([\d,]+) 的 ([\d.]+)%/g)][0];
  ok(!!m && num(m[1]) === worst, `D3g 那句里的最贵节点 ${m?.[1]} 等于重算的全场最大`, m ? `文档 ${m[1]} vs 重算 ${worst}` : '解析不到那句');
  ok(!!m && num(m[2]) === 60000000 && num(m[4]) === PROOF_BUDGET, `D3 ${m ? '那两个预算是 60,000,000 与 PROOF_BUDGET 现值' : '解析不到那两个预算'}`,
    m ? `文档 ${m[2]} / ${m[4]} vs 代码 60000000 / ${PROOF_BUDGET}` : '解析不到');
  ok(!!m && +m[3] === round1(100 * worst / num(m[2])) && +m[5] === round1(100 * worst / num(m[4])),
    `D3h 两个百分比按重算复核（${round1(100 * worst / 60000000)}% / ${round1(100 * worst / PROOF_BUDGET)}%）`,
    m ? `文档 ${m[3]}% / ${m[5]}%` : '解析不到');
}

// ---- D4 全线索墙：四行逐格重算，且它就是「不出 7×7」那句话的依据 ----------------------------
const wallDoc = [...DOCS.matchAll(/(\d) 阶 (\d+)\/(\d+)（([\d.]+)%）/g)];
ok(wallDoc.length >= 4, `D4a 文档的全线索墙解析到 ${wallDoc.length} 行（README 与 DESIGN 各一份，少一份就红）`,
  `解析 ${wallDoc.length} 行：${wallDoc.map((m) => `${m[1]}阶 ${m[2]}`).join(' ')}`);
for (const m of wallDoc) {
  const w = wall.get(+m[1]);
  ok(!!w && w.tried === +m[3] && w.ok === +m[2], `D4 ${m[1]} 阶墙 ${m[2]}/${m[3]} 逐格等于重跑（同种子 wall-${m[1]}-k）`,
    w ? `文档 ${m[2]}/${m[3]} vs 重算 ${w.ok}/${w.tried}` : '这一阶没跑');
  ok(!!w && +m[4] === round1(100 * w.ok / w.tried), `D4 ${m[1]} 阶墙的百分比 ${m[4]}% 等于重算`,
    w ? `文档 ${m[4]}% vs 重算 ${round1(100 * w.ok / w.tried)}%` : '这一阶没跑');
}
const wallCompact = README.match(/全线索墙仍是 ([\d/]+)、/);
ok(!!wallCompact && wallCompact[1] === [4, 5, 6, 7].map((n) => `${wall.get(n).ok}`).join('/'),
  'D4b README 开头那句「全线索墙仍是 70/53/6/0」这一串斜杠也等于重算',
  wallCompact ? `文档 ${wallCompact[1]} vs 重算 ${[4, 5, 6, 7].map((n) => `${wall.get(n).ok}`).join('/')}` : '解析不到那句');
const wallDesign = DESIGN.match(/墙探针 ([\d/]+) 一字不变/);
ok(!!wallDesign && wallDesign[1] === [4, 5, 6, 7].map((n) => `${wall.get(n).ok}`).join('/'),
  'D4c DESIGN 摘掉 Hall 那一处引用的墙探针串也等于重算（两处引用不许各漂各的）',
  wallDesign ? `文档 ${wallDesign[1]}` : '解析不到那句');
ok(wall.get(7).ok === 0 && !TIERS.some((t) => t.n >= 7),
  'D4 7 阶重算 0/120 且 TIERS 里确实没有 7 阶档（「不出 7×7 的全部理由」这一句的两个半边）',
  `7 阶 ${wall.get(7).ok}/${wall.get(7).tried} · TIERS 的 n = ${TIERS.map((t) => t.n).join('/')}`);
ok(MAX_N === 8 && Math.max(...TIERS.map((t) => t.n)) === 6,
  `D4d MAX_N = ${MAX_N} 而出货最高阶 = 6（README 那句「上限是排列表的上限而不是游戏的上限」）`,
  `MAX_N ${MAX_N} · 最高档 n ${Math.max(...TIERS.map((t) => t.n))}`);

// ---- D5 出厂 20 关：三套实现的账、按档节点上限、深度、levels.js 逐字节 ----------------------
const uniN = shipped.filter((x) => x.c.status === UNIQUE).length;
const penN = shipped.filter((x) => x.s.ok).length;
const naiveN = shipped.filter((x) => x.naive.solutions === 1).length;
const threeClaims = [...DOCS.matchAll(/唯一解 (\d+)、铅笔推到底 (\d+)、朴素枚举同判 (\d+)/g)];
ok(threeClaims.length >= 1 && threeClaims.every((m) => +m[1] === uniN && +m[2] === penN && +m[3] === naiveN),
  `D5 三套意见的账逐字等于重跑：唯一 ${uniN} / 铅笔 ${penN} / 朴素 ${naiveN}（文档写 ${threeClaims.map((m) => `${m[1]}/${m[2]}/${m[3]}`).join(' · ')}）`,
  `解析 ${threeClaims.length} 处`);
ok(shipped.length === 20 && LEVELS.length === 20 && naiveN === 20,
  `D5a 出厂关数解析到 ${LEVELS.length} 关，且两批计数都不是空转`, `${shipped.length} 张盘被真的重算过`);
const nodeRows = [...DESIGN.matchAll(/\| 穷举计数节点（出厂 20 关，按档最大） \| ([^|]+) \|/g)];
ok(nodeRows.length === 1, 'D5b DESIGN §9 那一行「出厂 20 关按档最大节点」解析到了', `${nodeRows.length} 行`);
{
  const cells = nodeRows.length ? [...nodeRows[0][1].matchAll(/(\w+) ([\d,]+)/g)].map((m) => ({ k: m[1], v: num(m[2]) })) : [];
  ok(cells.length === TIERS.length, `D5c 那一行解析到 ${TIERS.length} 个档位读数`, cells.map((c) => `${c.k} ${c.v}`).join(' · ') || '无');
  for (const c of cells) {
    const real = Math.max(...byTier.get(c.k).map((x) => x.c.nodes));
    ok(c.v === real, `D5 ${c.k} 出厂按档最大穷举节点 ${c.v} = 重算的 ${real}（预算 4,000,000）`,
      `文档 ${c.v} vs 重算 ${real}`);
  }
}
const liveNodeRows = [...DESIGN.matchAll(/\| 穷举计数节点（现场 24 题\/档，按档最大） \| ([^|]+) \|/g)];
ok(liveNodeRows.length === 1, 'D5d DESIGN §9 那一行「现场 24 题按档最大节点」解析到了', `${liveNodeRows.length} 行`);
{
  const vals = liveNodeRows.length ? liveNodeRows[0][1].split('·').map((x) => num(x)) : [];
  const real = TIERS.map((t) => Math.max(...live.get(t.key).nodesAt4M));
  ok(vals.length === TIERS.length && vals.join(',') === real.join(','),
    `D5e 现场按档最大节点逐格等于重算（${real.join(' · ')}）`, `文档 ${vals.join(' · ')}`);
}
const depthAll3 = shipped.every((x) => x.s.depth === 3) && TIERS.every((t) => Math.max(...live.get(t.key).depths) === 3);
ok(/`深度` 20 关全是 3/.test(DESIGN) && depthAll3, 'D5f 深度上限：出厂 20 关与现场五档重算全是 3',
  `出厂 ${Math.max(...shipped.map((x) => x.s.depth))} · 现场 ${TIERS.map((t) => Math.max(...live.get(t.key).depths)).join('/')}`);
const sha = createHash('sha256').update(readFileSync(join(ROOT, 'js/data/levels.js'))).digest('hex');
const shaClaims = [...DOCS.matchAll(/sha256 [`]?([0-9a-f]{8}|[0-9a-f]{64})[`]?/g)].map((m) => m[1]);
ok(shaClaims.length >= 2 && shaClaims.every((s) => sha.startsWith(s)),
  `D5g 文档两处 sha256（README 的短串 + DESIGN 的全串）都等于现在这份 levels.js 的摘要`,
  `实测 ${sha.slice(0, 12)}… · 文档 ${shaClaims.join(' / ')}`);
ok(/`js\/data\/levels\.js` 逐字节相同/.test(README) && /`js\/data\/levels\.js` 逐字节相同/.test(DESIGN),
  'D5h 两份文档都还写着「逐字节相同」这句话（sha 那一钉的语义半边，删了话就红）', '两份都在');
const recordedBad = shipped.filter((x) =>
  String(x.row.score) !== String(x.s.score) || String(x.row.steps) !== String(x.s.steps) ||
  String(x.row.clues) !== String(x.board.clues) || String(x.row.depth) !== String(x.s.depth) ||
  x.row.solution !== decodeGrid(x.row.n, x.row.solution).join(''));
ok(recordedBad.length === 0,
  'D5i levels.js 印着的读数仍等于从 clue 串重算的读数（生成器记的那一份不作数，重算才算）',
  recordedBad.length ? `漂了：${recordedBad.slice(0, 3).map((x) => x.row.id).join(' ')}` : '20 关逐字段相同');

// ---- D6 引擎单测：跑它自己，文档抄的条数/节数等于它打印的那一行 ----------------------------
const eng = spawnSync(process.execPath, [join(ROOT, 'tools/engine-test.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
const engOut = (eng.stdout || '') + (eng.stderr || '');
const engSum = engOut.match(/断言 (\d+) 条 · 通过 (\d+) · 失败 (\d+) · 通过率 [\d.]+% · 章节 (\d+) 节/);
ok(eng.status === 0 && !!engSum, `D6a engine-test 自己跑绿并打出合计行（rc=${eng.status}）`,
  engSum ? `断言 ${engSum[1]} · 通过 ${engSum[2]} · 失败 ${engSum[3]} · ${engSum[4]} 节` : engOut.slice(-200));
const engDocClaims = [...DOCS.matchAll(/(\d+) 条断言(?:全过|、)?(?:全过)?[^\d]{0,10}(\d+) 节/g)];
ok(engDocClaims.length >= 2, `D6b 文档里「N 条断言 · M 节」解析到 ${engDocClaims.length} 处（少于 2 处说明措辞改了）`,
  engDocClaims.map((m) => `${m[1]}/${m[2]}`).join(' · ') || '无');
ok(!!engSum && engDocClaims.every((m) => +m[1] === +engSum[1] && +m[2] === +engSum[4]),
  `D6 文档抄的引擎断言条数与节数逐处等于 engine-test 现在打印的（${engSum ? engSum[1] + ' 条 / ' + engSum[4] + ' 节' : '没读到'}）`,
  engDocClaims.map((m) => `文档 ${m[1]}/${m[2]}`).join(' · '));
// 复现块那一行是**四个数**（断言/通过/失败/章节），上面那条只认「N 条断言」这一种措辞：这一条把
// 另一种形状也钉上，四个数一个都不许各漂各的。
const engDocPlain = [...DOCS.matchAll(/断言 (\d+) · 通过 (\d+) · 失败 (\d+) · 章节 (\d+) 节/g)];
ok(engDocPlain.length >= 1 && !!engSum && engDocPlain.every((m) => m[1] === engSum[1] && m[2] === engSum[2]
  && m[3] === engSum[3] && m[4] === engSum[4]),
  `D6f 文档里那行「断言 N · 通过 N · 失败 0 · 章节 M 节」四个数逐处等于 engine-test 现在打印的（共 ${engDocPlain.length} 处）`,
  engDocPlain.map((m) => `文档 ${m[1]}/${m[2]}/${m[3]}/${m[4]} vs 打印 ${engSum ? `${engSum[1]}/${engSum[2]}/${engSum[3]}/${engSum[4]}` : '没读到'}`).join(' · '));
const secCalls = (ENGTEST.match(/^sec\(/gm) || []).length;const listedSecs = (ENGTEST.slice(ENGTEST.indexOf('Sections, in the order'), ENGTEST.indexOf('import {')).match(/^\/\/ {3}\S.*$/gm) || []).length;
ok(secCalls === (+engSum?.[4] || -1), `D6c engine-test 里 sec() 调用数 = 它自己打印的节数（${secCalls}）`,
  `sec() ${secCalls} vs 打印 ${engSum?.[4]}`);
ok(/章节清单列了 (\d+) 节，实际 `sec\(\)` 调用是 (\d+) 个/.test(DESIGN) &&
  +/章节清单列了 (\d+) 节，实际 `sec\(\)` 调用是 (\d+) 个/.exec(DESIGN)[1] === listedSecs &&
  +/章节清单列了 (\d+) 节，实际 `sec\(\)` 调用是 (\d+) 个/.exec(DESIGN)[2] === secCalls,
  `D6d DESIGN §10 第 5 条那两个数（清单 ${listedSecs} 节 / 实际 ${secCalls} 个）等于现在文件里的形状`,
  DESIGN.match(/章节清单列了 [\d\s]+节，实际 `sec\(\)` 调用是 \d+ 个/)?.[0] || '解析不到那条');
const histClaims = [...DOCS.matchAll(/(\d{4}) → (\d{4})/g)];
ok(histClaims.length >= 1 && histClaims.every((m) => +m[2] === +engSum?.[1]) && +engSum?.[1] !== +histClaims[0][1],
  `D6e 「旧数 → 现数」那几处的右半边等于现在打印的条数，左半边是被取代的旧数（${histClaims.map((m) => `${m[1]}→${m[2]}`).join(' ')}）`,
  engSum ? `现数 ${engSum[1]}` : '没读到');

// ---- D7 规则开火普查：DESIGN §4 那串明细由引擎单测与本地重算两头对 ------------------------
const censusLine = engOut.match(/(\d+) 张烘焙盘 · (\d+) 步 · 开火 (\d+) 种：([^\n]+)/);
ok(!!censusLine, 'D7a engine-test 打出的开火普查行解析到了', censusLine ? `${censusLine[2]} 步 · ${censusLine[3]} 种` : '解析不到');
const docCensus = DESIGN.match(/出厂 20 关共 \*\*(\d+) 步\*\*，只开火 \*\*(\d+) 种\*\*规则：\n?\s*`([^`]+)`/);
ok(!!docCensus, 'D7b DESIGN §4 那条「N 步 / M 种 + 明细串」解析到了', docCensus ? `文档 ${docCensus[1]} 步 / ${docCensus[2]} 种` : '解析不到');
ok(!!docCensus && +docCensus[1] === censusSteps && +docCensus[2] === fired.size,
  `D7 出厂 20 关的总步数与开火种数：重算 ${censusSteps} 步 / ${fired.size} 种`,
  docCensus ? `文档 ${docCensus[1]}/${docCensus[2]}` : '解析不到');
ok(!!docCensus && docCensus[3].split('/').map((x) => x.trim()).join('|') === firedSorted.map(([k, v]) => `${k} ${v}`).join('|'),
  'D7c DESIGN 那条明细串逐条（名字与次数与降序）等于重算',
  docCensus ? `文档 ${docCensus[3].slice(0, 46)}… vs 重算 ${firedSorted.map(([k, v]) => `${k} ${v}`).join(' / ').slice(0, 46)}…` : '解析不到');
const silentClaim = DESIGN.match(/\*\*沉默 (\d+) 条\*\*：((?:`[^`]+`、?)+)/);
ok(!!silentClaim && +silentClaim[1] === silentRules.length &&
  [...silentClaim[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]).join('|') === silentRules.join('|'),
  `D7d 沉默规则的名字与条数等于重算（${silentRules.join('、')}）`,
  silentClaim ? `文档 ${silentClaim[1]} 条「${silentClaim[2]}」` : '解析不到那句');
const tierKindClaim = DESIGN.match(/各档出厂盘用到的规则种数：([\w\d .·]+)/);
ok(!!tierKindClaim && tierKindClaim[1].trim().split(/[ ·]+/).join('') ===
  TIERS.map((t) => `${t.key}${perTierKind.get(t.key).size}`).join(''),
  `D7e 各档用到的规则种数逐档等于重算（${TIERS.map((t) => `${t.key} ${perTierKind.get(t.key).size}`).join(' · ')}）`,
  tierKindClaim ? `文档 ${tierKindClaim[1].trim()}` : '解析不到那句');
const topTwo = firedSorted.slice(0, 2).reduce((a, [, v]) => a + v, 0);
const fracClaim = DESIGN.match(/两类就占了 (\d+)\/(\d+) 步/);
ok(!!fracClaim && +fracClaim[1] === topTwo && +fracClaim[2] === censusSteps,
  `D7f 「两类占 N/M 步」等于重算的 ${topTwo}/${censusSteps}`, fracClaim ? `文档 ${fracClaim[1]}/${fracClaim[2]}` : '解析不到那句');
ok(!!censusLine && +censusLine[2] === censusSteps && +censusLine[3] === fired.size,
  `D7g 同一次 engine-test 打印的普查与本地重算同数（${censusSteps} 步 / ${fired.size} 种）`,
  censusLine ? `engine-test ${censusLine[2]}/${censusLine[3]}` : '解析不到');
ok(RULE_LIST.length === 13 && /(\d+) 条规则与其\*\*句子\*\*/.test(DESIGN) &&
  +/(\d+) 条规则与其\*\*句子\*\*/.exec(DESIGN)[1] === RULE_LIST.length,
  `D7h DESIGN §1 那句「N 条规则」等于 RULE_LIST 现长 ${RULE_LIST.length}`,
  DESIGN.match(/\d+ 条规则与其\*\*句子\*\*/)?.[0] || '解析不到那一格');

// ---- D8 七条 seed 夹具：Node 侧原样重算（README/DESIGN 的 gen 那一列也跟着重算）------------
const fxBlock = SCEN.split('// >>>FIXTURE')[1];
const fxBody = fxBlock && fxBlock.split('// <<<FIXTURE')[0];
ok(!!fxBody, 'D8a scenarios.js 的 >>>FIXTURE … <<<FIXTURE 段解析到了（这一段没了跨引擎那一钉就空转）', fxBody ? '在' : '不在');
const fixture = fxBody ? JSON.parse(fxBody.slice(fxBody.indexOf('['), fxBody.lastIndexOf(']') + 1)) : [];
const fxDocCount = [...DOCS.matchAll(/(\d+) 条 seed 指纹|(\d+) 张按 seed 重搭/g)].map((m) => +(m[1] || m[2]));
ok(fixture.length === 7 && fxDocCount.length >= 2 && fxDocCount.every((v) => v === fixture.length),
  `D8 夹具条数：重算到 ${fixture.length} 行，文档两处都写 ${fxDocCount.join('/')}（不一致就红）`,
  `解析 ${fixture.length} 行`);
const fxFields = ['n', 'clue', 'solution', 'derived', 'score', 'steps', 'places', 'prunes', 'eliminated', 'rounds', 'depth', 'clues', 'originSeed', 'genSeed', 'gen'];
const fxBad = [];
const genFromFixture = [];
for (const row of fixture) {
  const p = row.daily
    ? dailyPuzzle(new Date(2026, +row.daily.slice(5, 7) - 1, +row.daily.slice(8, 10)))
    : puzzleFromTier(row.tier, row.seed);
  if (!p) { fxBad.push(`${row.seed}: 出不了盘`); continue; }
  const s = solve(p.board);
  const got = {
    n: p.n, clue: encodeClue(p.board.clue), solution: Array.from(p.solution).join(''), derived: Array.from(s.derived).join(''),
    score: p.score, steps: p.steps, places: p.places, prunes: p.prunes, eliminated: p.eliminated,
    rounds: p.rounds, depth: p.depth, clues: p.board.clues, originSeed: p.originSeed, genSeed: p.seed, gen: p.gen,
  };
  const diff = fxFields.filter((k) => String(got[k]) !== String(row[k]));
  if (diff.length) fxBad.push(`${row.seed}: ${diff.map((k) => `${k} ${row[k]}→${got[k]}`).join(' / ')}`);
  genFromFixture.push(got.gen);
}
ok(fxBad.length === 0, `D8b 夹具的 ${fxFields.length} 个字段全部由 Node 原样重算出来（不是抄 Chrome 上次印的）`,
  fxBad.length ? fxBad.slice(0, 2).join('；') : `${fixture.length}/${fixture.length} 条相同`);
const genDocClaims = [...DOCS.matchAll(/（([\d /]+)）：?(?:这些种子|复核)?/g)]
  .map((m) => m[1].split(/\s*\/\s*/).map(Number))
  .filter((a) => a.length === fixture.length);
ok(genDocClaims.length >= 1 && genDocClaims.some((a) => a.join(',') === genFromFixture.join(',')),
  `D8c 文档那串 gen 计数（1 / 1 / 14 / 7 / 5 / 12 / 1 的形状）等于重算的 proof 采样数`,
  genDocClaims.map((a) => a.join('/')).join(' | ') || '解析不到那串');
const dailyClaim = DESIGN.match(/`daily:([\d-]+)` 钉成 `dailyTier: (\w+)`/);
{
  const p = dailyClaim && dailyPuzzle(new Date(2026, +dailyClaim[1].slice(5, 7) - 1, +dailyClaim[1].slice(8, 10)));
  ok(!!dailyClaim && !!p && p.tier === dailyClaim[2],
    `D8d 日课那一钉：daily:${dailyClaim ? dailyClaim[1] : '?'} 重算出来的档位是 ${p ? p.tier : '?'}`,
    dailyClaim ? `文档 ${dailyClaim[2]}` : '解析不到那句');
}

// ---- D9 闸的形状：场景名、条数算式、端口、CI 接线，全部读脚本现值 --------------------------
const doneNames = (VERIFY.match(/SCENARIOS_DONE="([^"]*)"/) || [, ''])[1].trim().split(/\s+/).filter(Boolean);
const scnNames = ((SCEN.match(/w\.__scn = \{([^}]*)\}/) || [, ''])[1].split(',').map((x) => x.trim().split(':')[0]).filter(Boolean));
ok(doneNames.length === 8 && scnNames.length === 8 && doneNames.join('|') === scnNames.join('|'),
  `D9a verify.sh 的默认场景清单与 scenarios.js 注册的 __scn 键逐字同序（${doneNames.join(' ')}）`,
  `脚本 ${doneNames.length} 个 · 注册 ${scnNames.length} 个：${scnNames.join(' ')}`);
const shapeClaims = [...DOCS.matchAll(/(?:每形|两种形态各) (\d+) 场景/g)];
ok(shapeClaims.length >= 2 && shapeClaims.every((m) => +m[1] === doneNames.length),
  `D9b 两份文档说的「每形 N 场景」等于脚本的清单长度 ${doneNames.length}`,
  shapeClaims.map((m) => m[1]).join('/') || '解析不到');
const addendRe = /((?:\d+\+?){8,})\s*=\s*(\d+)/;
const addendMatch = README.match(addendRe);
const sumA = (addendMatch || [])[1];
const totalClaim = (addendMatch || [])[2];
const addends = sumA ? sumA.replace(/\+$/, '').split('+').map(Number) : [];
ok(addends.length === doneNames.length && !!totalClaim && addends.reduce((a, b) => a + b, 0) === +totalClaim,
  `D9c 文档那条「逐场景条数相加 = 合计」的算式自己平（${addends.join('+')} = ${totalClaim}）`,
  sumA ? `${addends.length} 项 · 加起来 ${addends.reduce((a, b) => a + b, 0)} vs 写的 ${totalClaim}` : '解析不到算式');
const perShape = [...DOCS.replace(/\n/g, ' ').matchAll(/first (\d+) \+ seed (\d+) \+ rules (\d+) \+ unique (\d+) \+ play (\d+) \+ conflict (\d+) \+ hint (\d+) \+ stats (\d+) = (\d+) 条/g)];
ok(perShape.length === 1 && perShape[0][9] === totalClaim &&
  perShape[0].slice(1, 9).map(Number).join('+') === addends.join('+'),
  'D9d DESIGN 那份带名字的逐场景串与 README 那份纯数字串是同一组数（两处引用不许各漂各的）',
  perShape.length ? `DESIGN ${perShape[0][9]} 条 · README ${totalClaim} 条` : '解析不到带名字的那串');
const unpinnedCounts = /每形 8 场景 = [\d+]+ = 507 条/.test(README) && /507/.test(DESIGN);
ok(unpinnedCounts,
  'D9e 逐场景条数本身只在浏览器腿里被测到：文档把 507 挂在「浏览器闸」名下、没挂成 Node 现值（本闸不重测浏览器）',
  'README/DESIGN 都把它写在浏览器闸那一句里');
const want = (VERIFY.match(/CDP_WANT=\$\{CDP_PORT:-(\d+)\}/) || [, ''])[1];
const httpWant = (VERIFY.match(/HTTP_WANT=\$\{HTTP_PORT:-(\d+)\}/) || [, ''])[1];
const prefWant = (VERIFY.match(/PREF_WANT=\$\{PREFIX_PORT:-(\d+)\}/) || [, ''])[1];
ok(!!want && !!httpWant && !!prefWant, `D9f verify.sh 的三个 want 端口都解析到了（${httpWant}/${prefWant}/${want}）`,
  `HTTP ${httpWant} · PREFIX ${prefWant} · CDP ${want}`);
ok(/first_free/.test(VERIFY) && /CDP=\$\(first_free "\$CDP_WANT"\)/.test(VERIFY) &&
  /HTTP=\$\(first_free "\$HTTP_WANT"\)/.test(VERIFY),
  'D9g verify.sh 确实从 want 往后再挑空闲口（first_free）：文档里的端口是「want」，不是「一定用这个」',
  VERIFY.match(/first_free/) ? 'first_free 在' : '没有 first_free');
const portDocs = [...DOCS.matchAll(/根 (\d+)、前缀 (\d+)/g)];
ok(portDocs.length >= 1 && portDocs.every((m) => +m[1] === +httpWant && +m[2] === +prefWant),
  `D9 文档写的「根／前缀」两个端口等于脚本声明的 want（${httpWant}/${prefWant}）`,
  portDocs.map((m) => `${m[1]}/${m[2]}`).join(' · ') || '解析不到那句');
const devPort = (PKG.scripts?.dev || '').match(/server\.cjs\s+(\d+)/);
ok(!!devPort && +devPort[1] === +httpWant && /端口 (\d+)/.test(README) && +/端口 (\d+)/.exec(README)[1] === +httpWant,
  `D9h package.json 的 dev 端口、README 那句「端口 N」与脚本的 HTTP want 三处同一个数（${devPort?.[1]}）`,
  `dev ${devPort?.[1]} · 文档 ${(README.match(/端口 (\d+)/) || [])[1]} · 脚本 want ${httpWant}`);
const playCdp = (PLAYTEST.match(/CDP_PORT \|\| (\d+)/) || [, ''])[1];
const playBase = (PLAYTEST.match(/BASE_URL \|\| 'http:\/\/127\.0\.0\.1:(\d+)/) || [, ''])[1];
ok(!!playCdp && !!playBase && +playCdp === +want && +playBase === +httpWant,
  `D9i playtest.cjs 的两个默认值等于脚本的 want（CDP ${playCdp} / HTTP ${playBase}）`,
  `playtest ${playCdp}/${playBase} vs want ${want}/${httpWant}`);
const ciSamples = (CI.match(/SAMPLES: "(\d+)"/) || [, ''])[1];
const docCiSamples = [...DOCS.matchAll(/SAMPLES: "(\d+)"/g)].map((m) => +m[1]);
const docLocalSamples = [...DOCS.matchAll(/SAMPLES=(\d+)/g)].map((m) => +m[1]);
const balDefault = (BAL.match(/process\.env\.SAMPLES \|\| (\d+)/) || [, ''])[1];
ok(!!ciSamples && docCiSamples.length >= 2 && docCiSamples.every((v) => v === +ciSamples) &&
  docLocalSamples.length >= 3 && docLocalSamples.every((v) => v === SAMPLES_DOC) && +balDefault === 8,
  `D9j CI 的 SAMPLES（${ciSamples}）与文档引用一致，文档引用的本机口径一致（${SAMPLES_DOC}），balance 的默认是 ${balDefault}`,
  `ci ${ciSamples} · 文档 CI ${docCiSamples.join('/')} · 文档本机 ${docLocalSamples.join('/')} · 默认 ${balDefault}`);
const ciGates = [...new Set((CI.match(/(?:node|bash) tools\/[\w.-]+/g) || []).map((x) => x.replace(/^node |^bash /, '')))];
const docMentionedGates = ciGates.filter((g) => DOCS.includes(g.split('/').pop()));
ok(ciGates.length >= 5 && docMentionedGates.length === ciGates.length,
  `D9k ci.yml 里跑的每一个 tools 门禁都被文档点名（${ciGates.length} 个：${ciGates.join(', ')}）`,
  ciGates.filter((g) => !docMentionedGates.includes(g)).join(',') || '全部点名');
for (const gate of ['tools/doctest.mjs', 'tools/sabotage.mjs']) {
  ok(CI.includes(gate) && VERIFY.includes(gate.split('/').pop()) && PKG.scripts[gate === 'tools/doctest.mjs' ? 'doctest' : 'sabotage'],
    `D9l ${gate} 三处都接上了：ci.yml 有它、verify.sh 叫它、npm scripts 指它`,
    `ci ${CI.includes(gate)} · verify ${VERIFY.includes(gate.split('/').pop())} · npm ${!!PKG.scripts[gate === 'tools/doctest.mjs' ? 'doctest' : 'sabotage']}`);
}
const rowsPin = (VERIFY.match(/DOCTEST_ROWS_WANT=\$\{DOCTEST_ROWS_WANT:-(\d+)\}/) || [, ''])[1];
const docRowsPin = [...DOCS.matchAll(/tools\/verify\.sh 里钉的 doctest 断言数是 (\d+)/g)].map((m) => +m[1]);
ok(!!rowsPin && docRowsPin.length >= 1 && docRowsPin.every((v) => v === +rowsPin),
  `D9m verify.sh 钉住的 doctest 断言条数（${rowsPin}）与文档说的是同一个数`,
  `脚本 ${rowsPin} · 文档 ${docRowsPin.join('/')}`);

// ---- D10 path:NN 引用不漂：范围 + 锚点两头对 ----------------------------------------------
const cites = [...DOCS.matchAll(/((?:\.github\/workflows\/)?[\w./-]+\.(?:js|mjs|cjs|sh|json|html|yml|css)):(\d+)(?:-(\d+))?/g)];
ok(cites.length >= 60, `D10a 文档里的 path:NN 引用解析到 ${cites.length} 条（少于 60 条说明引用格式改了）`,
  `解析 ${cites.length} 条`);
const lineCache = new Map();
const KNOWN_PATHS = [];
const walkTree = (dir) => {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const q = `${dir}/${e.name}`;
    if (e.isDirectory()) walkTree(q);
    else if (/\.(js|mjs|cjs|sh|json|html|yml|css)$/.test(e.name)) KNOWN_PATHS.push(q);
  }
};
for (const d of ['js', 'tools', 'css', 'electron', '.github/workflows']) walkTree(d);
KNOWN_PATHS.push('package.json', 'index.html');
const resolve = (f) => {
  if (existsSync(join(ROOT, f))) return f;
  const hits = KNOWN_PATHS.filter((x) => x === f || x.endsWith('/' + f));
  return hits.length === 1 ? hits[0] : null;
};
const linesOf = (f) => {
  const real = resolve(f);
  if (!real) return null;
  if (!lineCache.has(real)) {
    try { lineCache.set(real, read(real).split('\n')); } catch { lineCache.set(real, null); }
  }
  return lineCache.get(real);
};
// 一条引用的三道查抽成一个函数，是因为下面那把刀要走**同一条代码路径**：把空行那一道删掉，
// oob 照样全绿，只有这一把会立刻红——否则新加的那道查就是没有对照的等式。
const citeMiss = (file, fromRaw, toRaw) => {
  const src = linesOf(file);
  if (!src) return `${file}（文件不存在）`;
  const from = +fromRaw;
  const to = +(toRaw || fromRaw);
  const label = `${file}:${fromRaw}${toRaw ? '-' + toRaw : ''}`;
  if (from > src.length || to > src.length) return `${label}（只有 ${src.length} 行）`;
  // 「在界内」不等于「指到了代码」：不带名字的裸引用只过这一道范围检查（D10f 那段写明它不核锚点），
  // 所以整段空白的情况必须在这里红——否则它指着的是一片行距，两道查都会放它过。
  if (src.slice(from - 1, to).join('').trim() === '') return `${label} 那几行整段是空行`;
  return '';
};
const oob = [];
for (const c of cites) {
  const miss = citeMiss(c[1], c[2], c[3]);
  if (miss) oob.push(miss);
}
// 反空转的刀：目标行号现量（`js/engine/skyscraper.js` 的第一处空行），不写死——写死的那个数会在
// 有人填了那一行之后悄悄地不再测任何东西，`blankAt > 0` 把那天变成红。
const probeBlank = linesOf('js/engine/skyscraper.js') || [];
let blankAt = 0;
for (let i = 1; i < probeBlank.length; i++) if (String(probeBlank[i]).trim() === '') { blankAt = i + 1; break; }
const blankKnife = blankAt ? citeMiss('js/engine/skyscraper.js', blankAt, null) : '';
ok(oob.length === 0 && blankAt > 0 && blankKnife.includes('整段是空行'),
  `D10 每一条 path:NN 都落在真实文件的行数内、且不整段是空行（${cites.length} 条；这一格自己带一把指着空行的刀）`,
  oob.length ? `越界或空行：${oob.slice(0, 4).join('，')}`
    : (blankKnife || '（刀没红：空行那道查是摆设）') + ` · 真引用 ${cites.length} 条全在范围内`);
const ANCHORS = [
  ['js/engine/skyscraper.js', 26, 'EMPTY'], ['js/engine/skyscraper.js', 28, 'SIDES'], ['js/engine/skyscraper.js', 50, 'clueIndex'],
  ['js/engine/skyscraper.js', 99, 'n + 1'], ['js/engine/skyscraper.js', 149, 'one:'], ['js/engine/skyscraper.js', 156, 'all:'],
  ['js/engine/skyscraper.js', 184, 'set:'], ['js/engine/skyscraper.js', 259, 'cluePair'], ['js/engine/skyscraper.js', 392, 'propagate'],
  ['js/engine/skyscraper.js', 540, 'surviving'], ['js/engine/skyscraper.js', 590, 'export function solve'],
  ['js/engine/skyscraper.js', 640, 'deadEnd'], ['js/engine/skyscraper.js', 348, 'hallSweep'], ['js/engine/skyscraper.js', 25, 'DESIGN.md §2'],
  ['js/engine/skyscraper.js', 347, 'DESIGN.md §4'], ['js/engine/perm.js', 17, 'MAX_N'], ['js/engine/perm.js', 92, 'NO_CLUE'],
  ['js/engine/perm.js', 9, 'DESIGN.md §5'], ['js/engine/perm.js', 14, 'DESIGN.md §3'], ['js/engine/perm.js', 48, 'permTable'],
  ['js/engine/count.js', 19, 'ABSENT'], ['js/engine/count.js', 48, 'export function countSolutions'],
  ['js/engine/count.js', 157, 'export function countNaive'], ['js/engine/count.js', 60, 'throw'],
  ['js/engine/generate.js', 65, 'PROOF_BUDGET'], ['js/engine/generate.js', 253, 'countSolutions'],
  ['js/engine/generate.js', 163, 'progress'], ['js/engine/generate.js', 340, 'export const TIERS'],
  ['js/engine/generate.js', 357, 'DESIGN.md §8'], ['js/engine/generate.js', 67, 'export function mix'],
  ['tools/balance.mjs', 41, 'COUNT_BUDGET'], ['tools/balance.mjs', 43, 'Math.floor(p * sorted.length)'],
  ['tools/balance.mjs', 6, 'README/DESIGN'], ['tools/balance.mjs', 133, 'p.proof.handed >= 1'],
  ['tools/balance.mjs', 145, 'countSolutions'], ['tools/balance.mjs', 220, "byTier.get('casual')"], ['tools/balance.mjs', 231, 'STIRLING'],
  ['tools/bake.mjs', 95, '六阶的 Hall 家族'], ['tools/bake.mjs', 18, 'DESIGN.md §8'], ['tools/bake.mjs', 251, 'LATIN'],
  ['tools/verify.sh', 33, 'SCENARIOS_DONE'], ['tools/verify.sh', 156, '条 seed 指纹仍由 node 原样重算出来'], ['tools/scenarios.js', 415, '"tier":"novice"'],
  ['tools/scenarios.js', 752, '4000000'], ['tools/engine-test.mjs', 473, '致命图案'], ['tools/engine-test.mjs', 1544, 'sec('],
  ['tools/engine-test.mjs', 740, '60,000,000'], ['js/main.js', 564, 'Hall'], ['js/main.js', 135, '44 px touch floor'],
  ['js/ui/game.js', 50, 'this.script = solve(puzzle.board).rows'], ['js/ui/game.js', 268, 'row.rule.text'],
  ['js/store.js', 6, 'skyscraper.save.v1'], ['js/render/board.js', 15, 'layoutFor'], ['js/theme.js', 58, 'min: 26'],
  ['css/game.css', 447, '44'], ['js/engine/rng.js', 39, 'dateSeed'], ['index.html', 112, 'aria-live'],
];
const citeSet = new Set(cites.map((c) => `${c[1]}:${c[2]}`));
// 文档引用行号的三种写法都要认：`file:NN`、`file:NN-MM`（区间里的每一行都算被引用）、
// 以及紧跟在同文件引用之后的简写 `:NN` / `:NN-MM`（本仓的散文里就是这么写的，如 `js/main.js:587`、`:592-593`）。
const docLines = new Set();
{
  let last = null;
  const re = /([\w./-]+\.(?:js|mjs|cjs|sh|json|html|yml|css)):(\d+)(?:-(\d+))?|(?<![\w./-]):(\d+)(?:-(\d+))?/g;
  for (const m of DOCS.matchAll(re)) {
    const f = m[1] ? resolve(m[1]) : last;
    if (!f) continue;
    const a = +(m[2] || m[4]);
    const b = +(m[3] || m[5] || m[2] || m[4]);
    if (Number.isNaN(a)) continue;
    last = m[1] ? f : last;
    for (let n = a; n <= b; n++) docLines.add(`${f}:${n}`);
  }
}
let anchorHits = 0;
for (const [f, line, token] of ANCHORS) {
  const src = linesOf(f);
  const text = src ? src.slice(line - 1, line + 8).join('\n') : '';
  const hit = !!src && text.includes(token);
  if (hit) anchorHits++;
  ok(hit, `D10b ${f}:${line} 那一行（±4）坐着 ${token}（引用是锚点，不是装饰）`,
    src ? `${hit ? '含' : '不含'} · 该行是「${(src[line - 1] || '').trim().slice(0, 52)}」` : '文件不存在');
}
ok(anchorHits >= ANCHORS.length - 0, `D10c 锚点表 ${ANCHORS.length} 条全部命中（一条不中就红）`,
  `命中 ${anchorHits}/${ANCHORS.length}`);
// ±8 的窗口只用来容忍"这附近坐着它"；钉行号这件事本身必须是**精确**的：token 不在那一行、
// 或文档引用的行号与锚点表不一致，都算引用漂了（README「文档纪律」那一条的执行器）。
const offLine = ANCHORS.filter(([f, line, token]) => {
  const src = linesOf(f);
  return !src || !(src[line - 1] || '').includes(token);
});
ok(offLine.length === 0, `D10c2 锚点表每一条的标识符都在它写的那一行上（不靠 ±8 窗口蒙）`,
  offLine.length ? offLine.map(([f, l, t]) => `${f}:${l}≠${t}`).join(' ') : '全部精确');
// 锚点表里有三条不是文档引用的行号，而是**这道闸自己要用的**落点（文档只在别处引它们）。它们被显式列在
// INTERNAL 里，最多 4 条：把一条挪进来就等于承认"文档没有钉它"，所以这一格自己也要被数一遍。
const INTERNAL = ['js/engine/perm.js:48'];
const notCited = ANCHORS
  .filter(([f, line]) => !INTERNAL.includes(`${resolve(f)}:${line}`))
  .filter(([f, line]) => !docLines.has(`${resolve(f)}:${line}`));
ok(notCited.length === 0 && INTERNAL.length <= 4,
  `D10c3 锚点表钉的每一行都真是文档此刻引用的那一行（表 ⊆ 文档；闸自用的 ${INTERNAL.length} 条除外）——文档把 95 改回 90，这一行就没人引用了 ⇒ 红`,
  notCited.length ? notCited.map(([f, l]) => `${f}:${l}`).join(' ') : `对齐（内部 ${INTERNAL.join('/') || '无'}）`);
const docPaths = [...new Set((DOCS.match(/(?:tools|js|css|electron)\/[\w./-]+\.(?:js|mjs|cjs|sh|css)/g) || []))];
ok(docPaths.length >= 15 && docPaths.every((p) => existsSync(join(ROOT, p))),
  `D10d 文档点名的 ${docPaths.length} 个源文件都还在树里（删一个工具就得同时删掉提到它的话）`,
  docPaths.filter((p) => !existsSync(join(ROOT, p))).join('，') || '全部存在');
{
  const quoted = [...DOCS.matchAll(/（(\d+) 条范围 \+ (\d+) 条锚点）/g)].map((m) => [+m[1], +m[2]]);
  ok(quoted.length >= 1 && quoted.every(([a, b]) => a === cites.length && b === ANCHORS.length),
    `D10e 文档抄的那句「N 条范围 + M 条锚点」等于这一次真的解析到的条数（共 ${quoted.length} 处，每一处都得对）`,
    quoted.length ? `文档 ${quoted.map(([a, b]) => `${a}/${b}`).join(' ')} vs 本次 ${cites.length}/${ANCHORS.length}` : '解析不到那句');
}

// ---- D10f–i 锚点从文档现推：手抄表没覆盖的那些也逃不掉 ------------------------------------
// 上面那张 ANCHORS 是手抄的：它保证"抄进表的那几行"落得准，可文档里没被抄进表的引用只过了
// 范围检查。本轮抓到的就是这一格漏的：`js/main.js:922-923` 的 `window.App` 其实在 969-970，
// 922 在 1089 行的文件里当然"不越界"，于是它一路绿。这一段拿同一份文档当输入现推锚点——
// 贴着引用的那个反引号名字，必须真的出现在被指的那几行里。口径与家族其余仓的同一份。
// 口径写死在这里，别让读的人猜：一条锚点 = (文件, 行段, 名字) 这个三元组，同一处被两份文档各写一次
// 只算一条（mentions 另外打出来）；拿不到名字的裸 `path:NN` 这一段一条都不核，那部分仍只过 D10 的范围检查——
// 这就是 README「这条腿没覆盖什么」那一句的来源。
const FLEET_CITE = /^([\w./-]+\.(?:js|mjs|cjs|sh|json|html|yml|css)):(\d+)(?:-(\d+))?$/;
const FLEET_ID = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const tokOf = (body) => {
  const seg = body.includes('::') ? body.slice(body.lastIndexOf('::') + 2) : body;
  if (seg.includes('/')) return '';
  const head = seg.split('(')[0].trim();
  if (FLEET_ID.test(head)) return head;
  const lhs = head.split(/[=:]\s/)[0].trim();
  return FLEET_ID.test(lhs) ? lhs : '';
};
const seenAnchor = new Set();
const derived = [];
let derivedMentions = 0;   // 同一处锚点在两份文档里各写一次时，只算一条（口径：锚点是"哪一行 + 哪个名字"，不是提及次数）
{
  const spans = [...DOCS.matchAll(/`([^`\n]+)`/g)].map((m) => ({ body: m[1], s: m.index, end: m.index + m[0].length }));
  for (let i = 0; i < spans.length; i++) {
    const c = spans[i].body.match(FLEET_CITE);
    if (!c) continue;
    let anchor = '';
    const next = spans[i + 1];
    if (next) {
      const gap = DOCS.slice(spans[i].end, next.s);
      const g = gap.replace(/\s+/g, '');
      if (gap.length <= 4 && !gap.includes('\n') && (/^[（(]/.test(g) || g === '的')) anchor = tokOf(next.body);
    }
    if (!anchor && i > 0) {
      const prev = spans[i - 1];
      const gap = DOCS.slice(prev.end, spans[i].s);
      const g = gap.replace(/\s+/g, '');
      if (anchor === '' && gap.length <= 4 && !gap.includes('\n') && !/\s/.test(prev.body) &&
        (/^[（(]/.test(g) || /[\w一-鿿]/.test(g))) anchor = tokOf(prev.body);
    }
    if (!anchor) continue;
    const from = +c[2];
    const to = +(c[3] || c[2]);
    const key = `${c[1]}:${from}-${to}:${anchor}`;
    if (seenAnchor.has(key)) { derivedMentions++; continue; }
    seenAnchor.add(key);
    derived.push({ file: c[1], from, to, anchor, label: `${c[1]}:${from}${c[3] ? '-' + c[3] : ''}` });
  }
}
const dMiss = [];
// 整词口径（家族同一份）：`clue` 坐在声明 `clueRuns` 的那一行上不算命中。子串口径比它替掉的那张手抄表
// 更弱——一个短名字会"出现在"任何碰巧含它的标识符里——于是一次真的漂会被读成绿。上面 D10b 那张表核的是
// 抄进去的字面串（`DESIGN.md §2`、`44 px touch floor` 这种不是标识符），所以整词只用在现推的这一格。
const wordCache = new Map();
const hasWord = (text, name) => {
  if (!wordCache.has(name)) {
    wordCache.set(name, new RegExp('(^|[^A-Za-z0-9_$])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9_$])'));
  }
  return wordCache.get(name).test(text);
};
// 抽成一个函数，是为了下面那把截前缀的刀走**同一条代码路径**（与 D10 那把空行刀同一手法）。
const anchorMiss = (d) => {
  const src = linesOf(d.file);
  if (!src) return `${d.label} 解析不到文件`;
  if (d.to > src.length) return `${d.label} 越界（只有 ${src.length} 行）`;
  if (!hasWord(src.slice(d.from - 1, d.to).join('\n'), d.anchor)) return `${d.label} 那几行里没有 ${d.anchor}`;
  return '';
};
for (const d of derived) {
  const miss = anchorMiss(d);
  if (miss) dMiss.push(miss);
}
// 反空转的刀：从现推的锚点里挑一条，把名字截掉最后一格——截出来的串必须仍是被指那几行里某个标识符的
// 子串（旧口径放它过），同时不是一个完整标识符（新口径必须拦）。一把都挑不出来时是 null：那条断言当场红，
// 而不是静默地少一把（口径退回子串的那一天，正是所有候选都"过"的那一天）。
const wordKnife = (() => {
  for (const d of derived) {
    const src = linesOf(d.file);
    if (!src) continue;
    const body = src.slice(d.from - 1, d.to).join('\n');
    const cut = d.anchor.slice(0, -1);
    if (cut.length < 3 || !body.includes(d.anchor) || !body.includes(cut)) continue;
    const miss = anchorMiss({ ...d, anchor: cut });
    if (miss) return { label: d.label, cut, miss };
  }
  return null;
})();
ok(dMiss.length === 0 && !!wordKnife, `D10f 从文档现推的每一个锚点都作为完整标识符坐在被指的那几行里（整词口径；手抄表漏掉的那些也红，这一格自己带一把截前缀的刀）`,
  dMiss.length ? `漂 ${dMiss.length} 处：${dMiss.slice(0, 6).join('，')}`
    : (wordKnife ? `现推 ${derived.length} 条（另有 ${derivedMentions} 次是同一处的重复提及），全部落回原处 · 刀在 ${wordKnife.label} 截成 ${wordKnife.cut}`
      : '一把截前缀的刀都挑不出来——整词那一格没被测过'));
// 现推的那一套比手抄表多出来的部分才是这段的新覆盖面；一个都没有就说明它只是把表抄了一遍。
const tableCovers = (d) => ANCHORS.some(([f, l]) => resolve(f) === resolve(d.file) && l >= d.from && l <= d.to);
const beyondTable = derived.filter((d) => !tableCovers(d));
ok(derived.length >= 12 && beyondTable.length >= 2,
  `D10g 现推锚点不是把 ANCHORS 重抄一遍（少于 12 条就是解析断了，表外少于 2 条就是没有新覆盖面）`,
  `现推 ${derived.length} 条 · 其中手抄表没钉的 ${beyondTable.length} 条：` +
    (beyondTable.map((d) => `${d.label} 的 ${d.anchor}`).join('，') || '一条都没有——这段就只是在重抄那张表'));
{
  const quoted = [...DOCS.matchAll(/现推锚点 (\d+) 条/g)].map((m) => +m[1]);
  ok(quoted.length >= 1 && quoted.every((v) => v === derived.length),
    `D10h 文档抄的「现推锚点 N 条」等于这一次从文档推出来的条数（删掉这个数字同样算红）`,
    `闸数到 ${derived.length} · 文档写了 ${quoted.length} 处：${[...new Set(quoted)].join('/') || '一处都没写'}`);
  const outClaims = [...DOCS.matchAll(/手抄表没钉的 (\d+) 条/g)].map((m) => +m[1]);
  ok(outClaims.length >= 1 && outClaims.every((v) => v === beyondTable.length),
    `D10i 文档抄的「手抄表没钉的 N 条」等于这一次表外的那几条（这一格就是上面那条漏口的账）`,
    `闸数到 ${beyondTable.length} · 文档写了 ${outClaims.length} 处：${[...new Set(outClaims)].join('/') || '一处都没写'}`);
}

// ---- D11 表示层常数 + 「js/ 不读 tools/」那一类反向扫描 ------------------------------------
ok(EMPTY === 0 && NO_CLUE === -1, `D11a 两个哨兵的现值：EMPTY ${EMPTY} / NO_CLUE ${NO_CLUE}（文档说"写 0 也能跑"的两个数）`,
  `代码 ${EMPTY}/${NO_CLUE}`);
const countSentinels = read('js/engine/count.js');
const absentM = countSentinels.match(/const ABSENT = (-?\d+);/);
const nothingM = countSentinels.match(/const NOTHING = (-?\d+);/);
ok(!!absentM && !!nothingM && +absentM[1] === -1 && +nothingM[1] === 0,
  `D11b count.js 自己那对哨兵仍是 ABSENT=-1 / NOTHING=0`, `${absentM ? absentM[1] : '无'}/${nothingM ? nothingM[1] : '无'}`);
ok(SIDES.join('') === '上右下左' && clueIndex(4, 2, 1) === 2 * 4 + 1,
  `D11c SIDES 的顺序与 clueIndex 的算法等于文档写的那一句（${SIDES.join('/')}，side*n+line）`, SIDES.join('/'));
const stirlingClaims = [...DOCS.matchAll(/`(\d): ([\d,]+)`/g)];
const STIRLING = { 3: [2, 3, 1], 4: [6, 11, 6, 1], 5: [24, 50, 35, 10, 1], 6: [120, 274, 225, 85, 15, 1] };
ok(stirlingClaims.length >= 3, `D11d 文档那串 Stirling 行解析到 ${stirlingClaims.length} 条`,
  stirlingClaims.map((m) => `${m[1]}:${m[2]}`).join(' '));
for (const m of stirlingClaims) {
  const n = +m[1];
  const doc = m[2].split(',').map(Number);
  const real = STIRLING[n];
  const eng = distribution(n);
  ok(doc.join(',') === real.join(',') && real.every((v, k) => eng[k + 1] === v),
    `D11 ${n} 阶分布 ${m[2]} 同时等于外部 Stirling 行与 perm.js 的枚举`,
    `文档 ${doc.join(',')} · 递推 ${real.join(',')} · distribution ${[...eng].slice(1).join(',')}`);
}
const latinClaims = [...DOCS.matchAll(/(576|161,280|161280|812,851,200|1,128,960|1128960|9408)/g)].map((m) => m[1]);
ok(latinClaims.length >= 6, `D11e 拉丁方那几个外部常数在文档里解析到 ${latinClaims.length} 处`, latinClaims.join(' '));
ok(1128960 === 9408 * 120 && 812851200 === 9408 * 720 * 120,
  'D11f 「6 阶定首行 = 9408 × 5!」这一钉的算术成立，而全局那一票仍在 countSolutions 手上',
  `9408×5!=${9408 * 120} · 9408×6!×120=${9408 * 720 * 120}`);
const jsFiles = [];
const walk = (dir) => {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(e.name)) jsFiles.push(p);
  }
};
walk('js');
const jsReadsTools = jsFiles.filter((f) => /from '[^']*tools\/|require\([^)]*tools\//.test(read(f)));
ok(jsFiles.length >= 10 && jsReadsTools.length === 0,
  `D11g 「js/ 永不 import tools/」：扫了 ${jsFiles.length} 个模块，反向 import ${jsReadsTools.length} 处（扫不到东西时靠 D11g0 数行数）`,
  jsReadsTools.join('，') || '没有一处');
ok(jsFiles.length >= 10, `D11g0 上面那条反向扫描真的读了 ${jsFiles.length} 个 js 模块（0 个模块的"干净"不算绿）`,
  `${jsFiles.length} 个：${jsFiles.slice(0, 3).join(', ')}…`);
const DEFINER = 'js/engine/count.js';
const naiveInJs = jsFiles.filter((f) => f !== DEFINER && /countNaive\s*\(/.test(read(f).replace(/^\s*\/\/.*$/gm, '')));
const proofInJs = jsFiles.filter((f) => f !== DEFINER && /countSolutions\s*\(/.test(read(f).replace(/^\s*\/\/.*$/gm, '')));
ok(jsFiles.includes(DEFINER) && new RegExp(`export function countNaive`).test(read(DEFINER)) &&
  naiveInJs.length === 0 && proofInJs.join(',') === 'js/engine/generate.js',
  `D11h 运行时里穷举只有出题那一处：countSolutions 的 js/ 调用点 = ${proofInJs.join(',') || '无'}（文档说就是 generate.js 那一个），countNaive 除定义处 ${DEFINER} 外 0 处`,
  `countSolutions ${proofInJs.join(',')} · countNaive ${naiveInJs.join(',') || '0 处（定义除外）'} · 定义文件在扫描集里 ${jsFiles.includes(DEFINER)}`);
const proofCallLines = read('js/engine/generate.js').split('\n')
  .map((l, i) => (/countSolutions\s*\(/.test(l) && !/^\s*\/\//.test(l) ? i + 1 : 0)).filter(Boolean);
ok(proofCallLines.length === 1 && DOCS.includes(`generate.js:${proofCallLines[0]}`),
  `D11i2 出题路径上唯一的复核调用点在第 ${proofCallLines.join('/')} 行，文档就是按这个行号点它的`,
  `实有 ${proofCallLines.join(',')} · 文档引用 generate.js:253`);
ok(TIERS.every((t) => t.extras === 0), `D11i 五档的 extras 全 0（DESIGN §5「extras 在出货阶梯里是死的」）`,
  TIERS.map((t) => `${t.key}:${t.extras}`).join(' '));
ok(SAVE_KEY === 'skyscraper.save.v1' && new RegExp(`存档键是 \`${SAVE_KEY}\``).test(README),
  `D11j 存档键 ${SAVE_KEY} 的代码现值与 README 那句一致`, `代码 ${SAVE_KEY}`);
ok(Cell.min === 26 && Cell.minTouch === 44 && /--touch-min/.test(CSS),
  `D11k theme 的两个下限现值（Cell.min ${Cell.min} / minTouch ${Cell.minTouch}）等于文档，CSS 也从同一个变量拿数`,
  `theme ${Cell.min}/${Cell.minTouch} · css ${/--touch-min: (\d+)/.exec(CSS)?.[1]}`);

// ---- D12 代码注释里点名 DESIGN 的那几处（「四处」那句话自己得数得对）----------------------
const codeCites = [];
for (const f of [...jsFiles, ...['tools/bake.mjs', 'tools/balance.mjs', 'tools/engine-test.mjs', 'tools/scenarios.js', 'tools/playtest.cjs', 'tools/verify.sh', 'index.html']]) {
  for (const m of read(f).matchAll(/DESIGN\.md §(\d+)/g)) codeCites.push({ f, n: +m[1] });
}
const designSections = [...new Set((DESIGN.match(/^## §(\d+)/gm) || []).map((x) => +x.slice(4)))];
ok(codeCites.length >= 5, `D12a 代码里「DESIGN.md §N」的引用解析到 ${codeCites.length} 处（0 处不是绿）`,
  `${codeCites.length} 处：${codeCites.map((c) => `${c.f}§${c.n}`).join(' ')}`);
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
{
  const m = DESIGN.match(/代码注释里点名要这一份文件的(\d+|[一二三四五六七八九十])处是/);
  const listed = [...(DESIGN.match(/代码注释里点名要这一份文件的(?:\d+|[一二三四五六七八九十])处是([\s\S]*?)\n\n/) || [, ''])[1]
    .matchAll(/`?([\w./-]+\.(?:js|mjs|cjs|sh)):?(\d+)?`?（→ §(\d+)）/g)];
  ok(!!m && listed.length === codeCites.length &&
    (CN[m[1]] || +m[1]) === codeCites.length &&
    listed.every((l) => codeCites.some((c) => c.f === l[1] && c.n === +l[3])),
    `D12 「代码注释里点名要这一份文件的 N 处」那句的 N 与逐条清单都等于现在 grep 到的 ${codeCites.length} 处`,
    m ? `文档说 ${m[1]} 处 · 清单 ${listed.length} 条 · grep ${codeCites.length} 处` : '解析不到那句');
  const named = [...new Set(codeCites.map((c) => c.n))].sort((a, b) => a - b);
  const docNamed = [...new Set((README.match(/`DESIGN\.md` §([\d/§]+) 是代码注释里点名的几节/) || [, ''])[1]
    .replace(/§/g, '').split('/').filter(Boolean))].map(Number).sort((a, b) => a - b);
  ok(docNamed.join(',') === named.join(',') && named.every((n) => designSections.includes(n)),
    `D12b README 点名的那几节（§${named.join('/')}）等于代码注释真引用的集合，且都在 DESIGN 里存在`,
    `文档 ${docNamed.join('/')} vs grep ${named.join('/')} · DESIGN 有 §${designSections.join('/')}`);
}
const refs = [...DOCS.replace(/\n/g, ' ').matchAll(/DESIGN\.md`? §([\d/§]+)/g)]
  .flatMap((m) => m[1].split('/').map((x) => +x.replace(/^§/, '')));
ok(refs.length >= 4 && refs.every((n) => designSections.includes(n)),
  `D12c 文档里每一处「DESIGN.md §N」都指向存在的那一节（${refs.length} 处）`,
  `文档 ${[...new Set(refs)].join('/')} vs 实有 §${designSections.join('/')}`);

// ---- D13 墙钟那一类：文档不许把计时写成现值（本闸不重测，只钉「谁说的」）------------------
const msClaims = [...DOCS.matchAll(/(\d+(?:\.\d+)?) ?ms/g)].map((m) => m[1]);
const secClaims = [...DOCS.matchAll(/(\d+(?:\.\d+)?) ?s(?=[、）\s]|$)/g)].map((m) => m[1]);
ok(msClaims.length >= 6 && secClaims.length >= 6,
  `D13a 文档里的墙钟读数解析到了（ms ${msClaims.length} 处 · s ${secClaims.length} 处）——本闸一条都不重测，只数它们`,
  `ms ${msClaims.slice(0, 5).join('/')}… · s ${secClaims.join('/')}`);
ok(/随机器和负载变|随负载变|只作读数|不当结论用|不是承诺|不作为承诺/.test(README),
  'D13 「只留读数不当结论」那句话还在 README 里（ms 那一类唯一的免责钉）', '在');
ok(!/D\d+[^\d]{0,4}ms|断言\s*D\d+/.test(README), 'D13b 文档没有把任何 D 组编号说成毫秒数（本闸的编号不是读数）', '没有');

// ---- D14 自数：这一次跑了多少个组、文档声称的区间与条数对不对 -------------------------------
// 这一节是全闸的「反空转」兜底：前面任何一个组整段被删，emitted 就少一格、rows 就对不上钉的
// EXPECT_ROWS —— 两种删法（改代码 / 改文档）都会红。D14c/D14d 故意排在两条 ok 之后，
// 那时 D14 自己也已经进了 emitted。
const EXPECT_ROWS = 281;
const GROUPS_TOTAL = 14;
const groupClaims = [...DOCS.matchAll(/D1[–-]D?(\d+)/g)].map((m) => +m[1]);
ok(groupClaims.length >= 1 && groupClaims.every((v) => v === GROUPS_TOTAL),
  `D14a 文档写的 D 区间上界（${groupClaims.join('/')}）等于本闸的组数 ${GROUPS_TOTAL}`,
  `文档 ${groupClaims.join('/') || '解析不到'} vs 本闸 ${GROUPS_TOTAL}`);
const docExpect = [...DOCS.matchAll(/EXPECT_ROWS\D{0,12}(\d+)/g)].map((m) => +m[1]);
ok(docExpect.length >= 1 && docExpect.every((v) => v === EXPECT_ROWS),
  `D14b 文档引用的 EXPECT_ROWS（${docExpect.join('/') || '解析不到'}）等于文件里钉的那个（${EXPECT_ROWS}）`, `钉的 ${EXPECT_ROWS}`);
ok(emitted.size === GROUPS_TOTAL, `D14c 这一次真跑满 ${GROUPS_TOTAL} 个 D 组（整段删掉一组就红）`,
  `本次 ${emitted.size} 组：${[...emitted].sort((a, b) => +a.slice(1) - +b.slice(1)).join(' ')}`);
const dMentions = [...new Set((DOCS.match(/(?<![A-Za-z0-9_])D\d+/g) || []))].map((x) => +x.slice(1));
const unknownD = dMentions.filter((v) => !emitted.has(`D${v}`));
ok(dMentions.length >= 2 && unknownD.length === 0,
  `D14d 文档点名的每个 D 编号（共 ${dMentions.length} 个）这一次都真的跑了`,
  unknownD.length ? `没有对应检查：${unknownD.map((v) => 'D' + v).join(' ')}` : `点到 ${dMentions.sort((a, b) => a - b).join(',')} 全在`);
const rowsQuotes = [...DOCS.matchAll(/rows: (\d+) fail: 0/g)].map((m) => +m[1])
  .concat([...DOCS.matchAll(/全跑 (\d+) 条断言/g)].map((m) => +m[1]));
ok(rowsQuotes.length >= 3 && rowsQuotes.every((v) => v === EXPECT_ROWS),
  `D14e 文档抄的 doctest 条数（rows 尾巴与「全跑 N 条断言」，共 ${rowsQuotes.length} 处）等于钉的 ${EXPECT_ROWS}`,
  rowsQuotes.length ? rowsQuotes.join('/') : '解析不到');
// 台账的刀数是文档里另一个现值：加一把、删一把、把某把改名，文档那句都得跟着改，不然这一条红。
const knifeCount = [...read('tools/sabotage.mjs').matchAll(/^    id: '(K\d+)',/gm)].length;
const knifeClaims = [...DOCS.matchAll(/(\d+) 把刀/g)].map((m) => +m[1]);
ok(knifeCount >= 6 && knifeClaims.length >= 1 && knifeClaims.every((v) => v === knifeCount),
  `D14g 文档写的「N 把刀」等于台账上真的有几把（${knifeCount}）——刀加了没写进文档，或写了却没这把刀，都红`,
  `台账 ${knifeCount} 把 · 文档写了 ${knifeClaims.length} 处：${knifeClaims.join('/') || '一处都没写'}`);
// 这一条自己也要被数进去：ok() 在比较之后才 rows++，所以这里比的是 rows + 1 = 尾巴上那个合计。
ok(rows + 1 === EXPECT_ROWS, `D14f 这一次跑出的断言条数（含这一条）等于钉在文件里的 EXPECT_ROWS（${EXPECT_ROWS}）`,
  `实测 ${rows} + 1 vs 钉的 ${EXPECT_ROWS}：删掉一条 test 就得同时改这里，改错了就红`);

console.log(`\n合计 ${rows} 项，${fail.length} 项失败`);
console.log(`rows: ${rows} fail: ${fail.length}`);
if (fail.length) {
  for (const f of fail) console.log(`  未过：${f}`);
  process.exit(1);
}
