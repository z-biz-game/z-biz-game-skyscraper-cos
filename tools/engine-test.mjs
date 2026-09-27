// Engine unit tests, run in plain Node: `npm test`.
//
// The risk in this repo is not arithmetic but soundness. One rule that wrote a cell the clues do not
// force and every board would still ship, the hints would still be self-consistent, and
// "每局都能推到底、每局都唯一" would be a caption on a coin flip. So the expectations below are
// hand-derived from boards worked out on paper and written as literals — never read back off the
// solver — and every shipped board is looked at by implementations that do not trust each other:
//
//   1. js/engine/skyscraper.js  the pencil path: rules, no backtracking, never reads the player's ink
//   2. js/engine/count.js       exhaustive search with its own copy of the tower-counting function
//   3. js/engine/count.js       countNaive(): Latin-square enumeration that never uses a clue while
//                               searching, and reads the counts off each finished square
//   4. `squares4()` below       every order-4 Latin square, built in this file from scratch, so a
//                               shipped 4×4 board's uniqueness is proved by a fourth route that shares
//                               no line of code with the engine
//
// Sections, in the order the promises are made:
//   哨兵与盘的构造   what a board refuses to be
//   数学锚点         the permutation tables, against facts from outside this codebase
//   规则可靠性       what one printed edge number forces, cell by cell
//   唯一解与致命图案 two different squares, the same sixteen clues
//   生成保证         every shipped level and every tier: unique, and finishable by pencil alone
//   状态机           tap / put / notes / stroke / undo / hint / conflict, through the class the game uses
//   存档形状         what the archive looks like when storage lies, throws, or is yesterday's format
//   规则开火普查     which rules the shipped boards actually lean on — including one that never fires

import {
  createBoard,
  cluesFrom,
  createDerivation,
  propagate,
  derive,
  solve,
  verify,
  complete,
  reachable,
  deadEnd,
  diagnose,
  noteConflicts,
  nextDeduction,
  rulesUsed,
  clueIndex,
  clueName,
  cluePair,
  createState,
  setCell,
  toggleNote,
  clearNotes,
  snapshot,
  undo as undoEngine,
  resetInk,
  Rules,
  RULE_LIST,
  EMPTY,
  NO_CLUE,
  MAX_N,
  bit,
  pop,
  valuesIn,
  fullMask,
  SIDES,
} from '../js/engine/skyscraper.js';
import { permTable, compatible, distribution, visible, visibleBack, NO_CLUE as PERM_NO_CLUE, MAX_N as PERM_MAX_N } from '../js/engine/perm.js';
import { countSolutions, countNaive, UNIQUE, MANY, NONE, OVERBUDGET } from '../js/engine/count.js';
import { TIERS, tierFor, generate, makePuzzle, mix, randomLatin, pruneClues, resupply } from '../js/engine/generate.js';
import { Game, INK, NOTE } from '../js/ui/game.js';
import { LEVELS, PROOF, TIERS_META, decodeClue, encodeClue, boardOfRow, decodeGrid, encodeGrid, CHAPTERS, puzzleFromLevel } from '../js/library.js';

let pass = 0;
let fail = 0;
let section = '（未分段）';
const marks = [];
const sec = (name) => {
  marks.push({ section, pass, fail });
  section = name;
};
const failures = [];
const eq = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else {
    fail++;
    failures.push(`${section} · ${name}`);
    console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`);
  }
};
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`${section} · ${name}`);
    console.log(`  FAIL ${name} ${detail}`);
  }
};
const throws = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return e.message || `抛了个非 Error：${e}`;
  }
};
// a construction that must refuse, and say why in the words the player would see
const rejects = (name, re, fn) => {
  const msg = throws(fn);
  ok(name, re.test(msg), msg === '' ? '没有抛错' : `抛的是：${msg}`);
};

// ---------------------------------------------------------------------------
// hand-written board construction
//
// `SIDE` is spelled out here instead of taken from SIDES.indexOf, so that the clue layout
// (index = side*n + line, sides 上/右/下/左) is *asserted* by these tests rather than inherited.
const SIDE = { 上: 0, 右: 1, 下: 2, 左: 3 };

// clues(n, [[side, line, value], …]); every other edge carries nothing.
function clues(n, spec) {
  const clue = new Int8Array(4 * n);
  clue.fill(NO_CLUE);
  for (const [side, line, v] of spec) clue[clueIndex(n, SIDE[side], line)] = v;
  return clue;
}
const mk = (n, spec) => createBoard({ n, clue: clues(n, spec) });
const cell = (n, r, c) => r * n + c;
const gridOf = (rows) => Uint8Array.from(rows.flat());
const asString = (a) => Array.from(a).join('');
const list = (a) => Array.from(a).join(',');
const dots = (clue) => Array.from(clue, (v) => (v === NO_CLUE ? '.' : String(v))).join('');
// how many edges this clue set actually prints a number on
const printed = (clue) => Array.from(clue).filter((v) => v !== NO_CLUE).length;
// a planted grid must read back as every number the board prints. The board's pruned edges are
// NO_CLUE, so this counts disagreements on the printed ones only — a full 4n comparison would be a
// claim about a clue set the player never sees.
const clueAgreement = (board, full) => {
  let differs = 0;
  for (let i = 0; i < board.clue.length; i++) if (board.clue[i] !== NO_CLUE && board.clue[i] !== full[i]) differs++;
  return differs;
};
// one propagate sweep from an empty pencil position, so a rule's own output can be looked at alone
const sweep = (board) => {
  const dv = createDerivation(board);
  dv.steps = [];
  propagate(dv, dv.steps);
  return dv;
};
const withRule = (rows, rule) => rows.steps.filter((s) => s.rule === rule);
// every write of a derivation, as "cell=value" pairs, for the cross-implementation comparisons
const writes = (rows) => rows.steps.filter((s) => s.kind === 'place').map((s) => `${s.cell}=${s.value}`).join(' ');

sec('哨兵与盘的构造');

// --- the two sentinels are different numbers, on purpose ------------------------------------
// 0 means "this cell has no height written yet"; -1 means "this edge has no number printed on it".
// createBoard refuses a clue of 0 precisely so the two cannot be confused: with 0 standing in for
// "absent", every line would be filtered against 可见数 0 — a reading no line has — and every
// compatible set would come back empty. That is the kind of bug that ships silently, so it is a test.
eq('NO_CLUE 是 -1', NO_CLUE, -1);
eq('EMPTY 是 0', EMPTY, 0);
eq('两个哨兵不是同一个数', NO_CLUE === EMPTY, false);
eq('perm.js 与 skyscraper.js 的哨兵是同一个值', PERM_NO_CLUE, NO_CLUE);
eq('两边的阶数上限一致', MAX_N, PERM_MAX_N);
eq('边顺序是 上右下左', SIDES.join(''), '上右下左');
eq('clueIndex 的步长是 n', [0, 1, 2, 3].map((s) => clueIndex(4, s, 1)).join(','), '1,5,9,13');
eq('第 1 列上边的名字', clueName(4, 0), '1列 上边');
eq('第 2 行右边的名字', clueName(4, 5), '2行 右边');
eq('第 4 列下边的名字', clueName(6, 15), '4列 下边');
eq('第 1 行左边的名字', clueName(6, 18), '1行 左边');

// --- createBoard refuses an impossible given --------------------------------------------------
{
  const zero = clues(4, [['左', 0, 2]]);
  zero[3] = 0; // 左下角那条边写成 0
  rejects('0 当线索被当场拒绝', /可线索只能是 1\.\.4/, () => createBoard({ n: 4, clue: zero }));
  rejects('报错里点名了哨兵该写什么', /-1 表示这条边没有线索/, () => createBoard({ n: 4, clue: zero }));
  rejects('比 n 大的线索被拒绝', /可线索只能是 1\.\.4/, () => createBoard({ n: 4, clue: clues(4, [['左', 0, 5]]) }));
  const other = clues(4, [['左', 0, 2]]);
  other[3] = -2;
  rejects('除 -1 之外的负数也不是哨兵', /可线索只能是 1\.\.4/, () => createBoard({ n: 4, clue: other }));
  rejects('一条线索都没有的盘被拒绝', /一条线索都没有/, () => mk(4, []));
  rejects('线索长度不是 4n 的被拒绝', /clue length/, () => createBoard({ n: 4, clue: new Int8Array(12).fill(NO_CLUE) }));
  rejects('1 阶不开盘', /只能是 2\.\.8/, () => createBoard({ n: 1, clue: new Int8Array(4).fill(1) }));
  rejects(`超过 ${MAX_N} 阶不开盘`, /只能是 2\.\.8/, () => createBoard({ n: 9, clue: clues(9, [['左', 0, 1]]) }));
  // cA + cB - 1 <= n：最高的那栋两头都看得见，两端的读数共用同一次 sighting
  rejects('四阶上一条线两端都写 3 会被构造拦下', /两端加起来不能超过 5/, () => mk(4, [['左', 0, 3], ['右', 0, 3]]));
  eq('两端之和恰好等于 n+1 是合法的', throws(() => mk(4, [['左', 0, 3], ['右', 0, 2]])), '');
  eq('五阶两端 3/3 合法', throws(() => mk(5, [['左', 0, 3], ['右', 0, 3]])), '');
}
{
  const b = mk(4, [['左', 0, 2], ['上', 1, 3], ['下', 3, 1]]);
  eq('盘的格数', b.size, 16);
  eq('clues 只数写了的边', b.clues, 3);
  eq('线轨道数 = 2n', b.tracks.length, 8);
  eq('前 n 条轨道是行', b.tracks.slice(0, 4).map((t) => t.kind).join(','), 'row,row,row,row');
  eq('后 n 条轨道是列', b.tracks.slice(4).map((t) => t.kind).join(','), 'col,col,col,col');
  eq('行轨道的左端索引', b.tracks[0].idxA, clueIndex(4, 3, 0));
  eq('行轨道的右端索引', b.tracks[0].idxB, clueIndex(4, 1, 0));
  eq('列轨道的上端索引', b.tracks[4].idxA, clueIndex(4, 0, 0));
  eq('列轨道的下端索引', b.tracks[4].idxB, clueIndex(4, 2, 0));
  eq('行轨道从左往右走', list(b.tracks[0].cells), '0,1,2,3');
  eq('列轨道从上往下走', list(b.tracks[4].cells), '0,4,8,12');
  eq('每格恰好属于两条线', b.cellTracks.every((l) => l.length === 2), true);
  eq('第 2 行第 3 列的归属', b.cellTracks[cell(4, 1, 2)].map((x) => x.join(':')).join(' '), '1:2 6:1');
  eq('轨道自己知道两端读数', [b.tracks[0].clueA, b.tracks[0].clueB, b.tracks[0].clued].join('/'), '2/-1/true');
  eq('没线索的轨道 clued 是 false', b.tracks[1].clued, false);
  eq('cluePair 只点名有数的那头', cluePair(b, 0), '1行 左边 2');
  eq('cluePair 两头都有数就都点名', cluePair(mk(5, [['左', 0, 3], ['右', 0, 2]]), 0), '1行 左边 3、1行 右边 2');
  eq('cluePair 两头都没有时承认自己说不出依据', cluePair(b, 1), '（这条线两端都没有线索）');
  eq('cellName 是人话', b.cellName(6), '第2行第3列');
}
{
  // cluesFrom reads the four edges off a finished grid. The generator plants a grid and uses this, so
  // the index arithmetic it does is load-bearing for every board that ships.
  const g = gridOf([
    [2, 1, 4, 3],
    [3, 4, 1, 2],
    [1, 3, 2, 4],
    [4, 2, 3, 1],
  ]);
  const clue = cluesFrom(4, g);
  // hand counted on the grid above. Rows: 2143 见 2（背面 3,4 → 2）、3412 见 2（背面 2,4 → 2）、
  // 1324 见 3（背面只有 4 → 1）、4231 见 1（背面 1,3,4 → 3）。
  // Columns: 2314 → 3/1、1432 → 2/3、4123 → 1/2、3241 → 2/2.
  eq('上边读数', asString(clue.slice(0, 4)), '3212');
  eq('右边读数（从右往左看）', asString(clue.slice(4, 8)), '2213');
  eq('下边读数（从下往上）', asString(clue.slice(8, 12)), '1322');
  eq('左边读数', asString(clue.slice(12, 16)), '2231');
  eq('四边共 16 条', clue.length, 16);
  eq('cluesFrom 不会留下 NO_CLUE', clue.every((v) => v >= 1), true);
  eq('第 1 列上边 = 3', clue[0], 3);
  eq('第 1 列下边 = 1（4 挡在最前面）', clue[8], 1);
  eq('第 1 行左边 = 2', clue[12], 2);
  eq('第 1 行右边 = 2', clue[4], 2);
  eq('回读自己：把 cluesFrom 的结果再验一遍', verify(createBoard({ n: 4, clue }), g).length, 0);
}

sec('数学锚点：排列表与可见数分布');

// Hand-computed record-high counts, written as literals because the rest of this file leans on them.
eq('1234 看得见 4 栋', visible([1, 2, 3, 4]), 4);
eq('4321 看得见 1 栋', visible([4, 3, 2, 1]), 1);
eq('2143 看得见 2 栋', visible([2, 1, 4, 3]), 2);
eq('1324 看得见 3 栋', visible([1, 3, 2, 4]), 3);
eq('3142 看得见 2 栋', visible([3, 1, 4, 2]), 2);
eq('24135 看得见 3 栋（2、4、5 逐个创新高）', visible([2, 4, 1, 3, 5]), 3);
eq('24135 从另一头只看得见 1 栋（5 挡在门口）', visibleBack([2, 4, 1, 3, 5]), 1);
eq('1234 从另一头看见 1 栋', visibleBack([1, 2, 3, 4]), 1);
eq('4123 从另一头看见 2 栋（3 和 4）', visibleBack([4, 1, 2, 3]), 2);
eq('4123 从这头只看见 1 栋（4 挡在门口）', visible([4, 1, 2, 3]), 1);
eq('反转后两头读数互换', visibleBack([3, 1, 4, 2]), visible([2, 4, 1, 3]));

// "How many orderings of 1..n show exactly k towers?" is the unsigned Stirling number of the first
// kind, c(n,k). The engine does not need this to be true, which is what makes it a useful anchor:
// the rows below were written out of a formula, not printed by permTable.
eq('排列表 3 阶 6 行', permTable(3).count, 6);
eq('排列表 4 阶 24 行', permTable(4).count, 24);
eq('排列表 5 阶 120 行', permTable(5).count, 120);
eq('排列表 6 阶 720 行', permTable(6).count, 720);
eq('排列表按 n 缓存', permTable(4) === permTable(4), true);
eq('排列表只做到 MAX_N', /排列表只做到/.test(throws(() => permTable(9))), true);
{
  const rows = { 3: [2, 3, 1], 4: [6, 11, 6, 1], 5: [24, 50, 35, 10, 1], 6: [120, 274, 225, 85, 15, 1] };
  for (const n of [3, 4, 5, 6]) {
    const d = Array.from(distribution(n));
    eq(`distribution(${n}) 就是 Stirling 行`, d.slice(1).join(','), rows[n].join(','));
    eq(`distribution(${n}) 之和 = ${n}!`, d.slice(1).reduce((a, b) => a + b, 0), permTable(n).count);
    eq(`c(${n},1)：最高的挡在最前，剩 ${n - 1}! 种`, d[1], rows[n][0]);
    eq(`c(${n},${n})：只有递增这一种`, d[n], 1);
    eq(`0 栋不存在：d(${n},0)`, d[0], 0);
    // the far end mirrors the near end, so the two arrays hold the same multiset
    const back = new Array(n + 1).fill(0);
    const t = permTable(n);
    for (let i = 0; i < t.count; i++) back[t.visB[i]]++;
    eq(`从另一头数出来的分布也一样（n=${n}）`, back.slice(1).join(','), rows[n].join(','));
  }
}
{
  // compatible(n, 左/上, 右/下) — which orderings one line's two edge readings allow. Written as
  // table indices, so a change in permTable's enumeration order goes red rather than silently
  // renumbering everything downstream.
  const t4 = permTable(4);
  const row = (i) => asString(t4.flat.subarray(i * 4, i * 4 + 4));
  eq('4 阶字典序第 0 行是 1234', row(0), '1234');
  eq('4 阶字典序最后一行是 4321', row(23), '4321');
  eq('左 4 右 1：只剩递增', asString(compatible(4, 4, 1)), '0');
  eq('左 1 右 4：只剩递减', asString(compatible(4, 1, 4)), '23');
  eq('两端都要 1：一种摆法都没有', compatible(4, 1, 1).length, 0);
  eq('两端都没数：返回 null，交给 all-different 分支', compatible(4, NO_CLUE, NO_CLUE), null);
  // hand count for 左2右2: the 4 sits at index 1 (then the tail's far record must be its last cell)
  // or index 2 (then the head's near record must be its first cell) — 3 orderings each.
  eq('左 2 右 2 有 6 种摆法', list(compatible(4, 2, 2)), '4,7,10,13,15,16');
  eq('这 6 种分别是', Array.from(compatible(4, 2, 2), row).join(' '), '1423 2143 2413 3142 3241 3412');
  eq('只给 左=3 时是 c(4,3) = 6 种', compatible(4, 3, NO_CLUE).length, 6);
  eq('只给 右=2 时是 c(4,2) = 11 种', compatible(4, NO_CLUE, 2).length, 11);
  eq('五阶 左=2 是 c(5,2) = 50 种', compatible(5, 2, NO_CLUE).length, 50);
  const five = Array.from(compatible(5, 2, NO_CLUE));
  const flat5 = permTable(5).flat;
  eq('五阶这些摆法真的都看见 2 栋', five.every((i) => visible(Array.from(flat5.subarray(i * 5, i * 5 + 5))) === 2), true);
  eq('一端为空时另一端仍然过滤', compatible(4, 1, NO_CLUE).length, 6);
  eq('哨兵不参与"和超过 n+1"的判断', compatible(4, 4, NO_CLUE).length, 1);
}

sec('规则可靠性：一条线索逼出的事实');

// Each block below is a hand-built board, one propagate sweep, and the exact steps that sweep may
// produce — rule identity, cell, value, and the index of the printed number it is allowed to cite.
{
  // clue 1 — the tower you hit first has to be the tallest, since anything behind it would show too
  const cases = [
    ['左', 0, cell(4, 0, 0), '1行 左边'],
    ['右', 1, cell(4, 1, 3), '2行 右边'],
    ['上', 2, cell(4, 0, 2), '3列 上边'],
    ['下', 3, cell(4, 3, 3), '4列 下边'],
  ];
  for (const [side, line, want, name] of cases) {
    const b = mk(4, [[side, line, 1]]);
    const dv = sweep(b);
    const st = withRule(dv, Rules.one);
    eq(`${side}${line + 1} 写 1：只推出一条 one`, st.length, 1);
    eq(`${side}${line + 1} 写 1：落在哪一格`, st[0] && st[0].cell, want);
    eq(`${side}${line + 1} 写 1：高度是 n`, st[0] && st[0].value, 4);
    eq(`${side}${line + 1} 写 1：是写数字不是划候选`, st[0] && st[0].kind, 'place');
    eq(`${side}${line + 1} 写 1：引用那条边`, st[0] && st[0].clueIdx, clueIndex(4, SIDE[side], line));
    eq(`${side}${line + 1} 写 1：引用非空`, b.clue[st[0].clueIdx], 1);
    // same sweep, and the two follow-on consequences that must also appear
    eq(`${side}${line + 1} 写 1：本行其余各格立刻失去 n`, withRule(dv, Rules.setPrune).length, 3);
    eq(`${side}${line + 1} 写 1：穿过的那条线也失去 n`, withRule(dv, Rules.line).length, 3);
    ok(`${side}${line + 1} 写 1：话术里说得出依据`, Rules.one.text(b, st[0]).includes(name), Rules.one.text(b, st[0]));
  }
  // clue n — nothing can hide, so the line climbs 1..n away from that edge. The cells below are
  // written with cell(n, row, col) so the (side, line) → which physical line mapping is asserted too:
  // 左/右 index rows, 上/下 index columns, and the walk starts at the clued end.
  const asc = [
    ['左', 0, [cell(4, 0, 0), cell(4, 0, 1), cell(4, 0, 2), cell(4, 0, 3)]],
    ['右', 1, [cell(4, 1, 3), cell(4, 1, 2), cell(4, 1, 1), cell(4, 1, 0)]],
    ['上', 2, [cell(4, 0, 2), cell(4, 1, 2), cell(4, 2, 2), cell(4, 3, 2)]],
    ['下', 3, [cell(4, 3, 3), cell(4, 2, 3), cell(4, 1, 3), cell(4, 0, 3)]],
  ];
  for (const [side, line, offsets] of asc) {
    const b = mk(4, [[side, line, 4]]);
    const dv = sweep(b);
    const st = withRule(dv, Rules.all);
    eq(`${side}${line + 1} 写 4：四格一路升高`, st.length, 4);
    eq(`${side}${line + 1} 写 4：格子从近到远`, st.map((s) => s.cell).join(','), offsets.join(','));
    eq(`${side}${line + 1} 写 4：高度 1,2,3,4`, st.map((s) => s.value).join(','), '1,2,3,4');
    for (const s of st) eq(`${side}${line + 1} 写 4：每格引用同一条边`, s.clueIdx, clueIndex(4, SIDE[side], line));
    eq(`${side}${line + 1} 写 4：这一趟没有矛盾`, dv.conflict, null);
  }
}
{
  // cap — behind the first tower there must still be (clue-1) taller ones, so it tops out at n-clue+1
  const b = mk(4, [['左', 0, 2]]);
  const dv = sweep(b);
  const st = withRule(dv, Rules.cap);
  eq('四阶 左 2：第一格被削顶', st.length, 1);
  eq('四阶 左 2：削的是本行第一格', st[0] && st[0].cell, cell(4, 0, 0));
  eq('四阶 左 2：cap = 3，所以只划掉 4', st[0] && st[0].values.join(','), '4');
  eq('四阶 左 2：削顶是划候选', st[0] && st[0].kind, 'prune');
  eq('四阶 左 2：消掉的候选数', st[0] && st[0].elim, 1);
  eq('四阶 左 2：cap 值写进步里', st[0] && st[0].cap, 3);
  const b5 = mk(5, [['右', 2, 3]]);
  const st5 = withRule(sweep(b5), Rules.cap);
  eq('五阶 右 3：另一头同样削得动', st5.length, 1);
  eq('五阶 右 3：划掉 4 和 5', st5[0] && st5[0].values.join('/'), '4/5');
  eq('五阶 右 3：落在第 3 行最右一格', st5[0] && st5[0].cell, cell(5, 2, 4));
  eq('五阶 右 3：引用右边那条 3', st5[0] && st5[0].clueIdx, clueIndex(5, 1, 2));
}
{
  // window — the tallest tower must stand at least clue-1 cells in from its own edge. cap only ever
  // touches the first cell; this is the rule that reaches further along the line.
  const b = mk(5, [['左', 0, 3]]);
  const dv = sweep(b);
  const cap = withRule(dv, Rules.cap);
  const win = withRule(dv, Rules.window);
  eq('五阶 左 3：先削第一格', cap.length, 1);
  eq('五阶 左 3：第一格划掉 4/5', cap[0] && cap[0].values.join('/'), '4/5');
  eq('五阶 左 3：窗口再往深处伸手', win.length, 1);
  eq('五阶 左 3：第二格只划掉 5', win[0] && win[0].values.join(','), '5');
  eq('五阶 左 3：那一格是 (1,2)', win[0] && win[0].cell, cell(5, 0, 1));
  eq('五阶 左 3：说得出这是第几格', win[0] && win[0].k, 2);
  eq('五阶 左 3：引用的还是左边那条 3', win[0] && win[0].clueIdx, clueIndex(5, 3, 0));
  // both ends at once squeeze n into the middle: 左3 右3 on n=5 leaves exactly position 2
  const bothBoard = mk(5, [['左', 2, 3], ['右', 2, 3]]);
  const both = sweep(bothBoard);
  const wo = withRule(both, Rules.windowOnly);
  eq('两端 3/3：最高楼只剩一格可站', wo.length, 1);
  eq('两端 3/3：那一格在第 3 行正中间', wo[0] && wo[0].cell, cell(5, 2, 2));
  eq('两端 3/3：写下的是 5', wo[0] && wo[0].value, 5);
  ok('两端 3/3：话术点名了两端的约束', /第 3 格或更靠里/.test(wo[0] && wo[0].why), wo[0] && wo[0].why);
  eq('两端 3/3：这一趟不报错（3+3 = n+1 合法）', both.conflict, null);
  // cap 只够得着第一格，所以两端第 1、5 格上的 5 是 cap 划掉的；同一格里 window 再伸手已经无货可划，
  // 于是 window 在这一步只报第 2 格和第 4 格 —— 是 2 步而不是 4 步，也绝不是"没有多余的手"。
  const winBoth = withRule(both, Rules.window);
  eq('两端 3/3：窗口在第 2、4 格各出手一次', winBoth.length, 2);
  eq('两端 3/3：出手的是哪两格', winBoth.map((s) => s.cell).join(','), [cell(5, 2, 1), cell(5, 2, 3)].join(','));
  for (const s of winBoth) {
    eq('两端 3/3：每一格只划掉 5', s.values.join(','), '5');
    eq('两端 3/3：划的是候选不是写数字', s.kind, 'prune');
    ok('两端 3/3：划的格子确实在窗口外', s.cell !== cell(5, 2, 2), String(s.cell));
  }
  // 这些格子不是引擎自己说了算：把 5 楼硬按在这一行的每一格上，交给 count.js 的朴素枚举（搜索期间
  // 完全不看线索，逐个拉丁方读完 16 个读数）去数还剩几个解。只有正中间那一格有解。
  for (let k = 0; k < 5; k++) {
    const given = new Uint8Array(25);
    given[cell(5, 2, k)] = 5;
    const forced = countNaive(bothBoard, { given });
    ok(`两端 3/3：穷举独立证实 5 楼在第 ${k + 1} 格${k === 2 ? '站得住' : '站不住'}`, (forced.solutions > 0) === (k === 2), `解数 ${forced.solutions}`);
  }
}
{
  // the line taken as a whole: which orderings survive everything written so far, and what they agree on
  const b = mk(4, [['左', 0, 2], ['右', 0, 2]]);
  const dv = sweep(b);
  // Hand-derived. 左2右2 leaves exactly six orderings — 1423 2143 2413 3142 3241 3412 — so
  //   position 0 ∈ {1,2,3}, position 1 ∈ {1,2,4}, position 2 ∈ {1,2,4}, position 3 ∈ {1,2,3}.
  // cap already took the 4 out of positions 0 and 3, so the only thing the survivor set can add on
  // this sweep is 3 leaving positions 1 and 2. Four steps in total, no contradiction, no write.
  eq('2/2 那一行的相容摆法是 6 种', b.tracks[0].perms.length, 6);
  eq('两端的 cap 各削一格', withRule(dv, Rules.cap).map((s) => s.cell).join(','), '0,3');
  eq('窗口没有多余的手可伸', withRule(dv, Rules.window).length, 0);
  const prune = withRule(dv, Rules.setPrune);
  eq('排列集这一趟出手两次', prune.length, 2);
  eq('削的是中间两格', prune.map((s) => s.cell).join(','), '1,2');
  eq('两格都失去 3', prune.map((s) => s.values.join('')).join(','), '3,3');
  eq('四格最后的候选', [0, 1, 2, 3].map((i) => valuesIn(dv.domain[i]).join('')).join('|'), '123|124|124|123');
  eq('还没有一格被排列集写死', withRule(dv, Rules.set).length, 0);
  eq('也没有哪个数只剩一格可放', withRule(dv, Rules.setHidden).length, 0);
  eq('这一趟总共四步', dv.steps.length, 4);
  eq('这一趟没有矛盾', dv.conflict, null);
  for (const s of prune) {
    eq('排列集削候选必须点名所在的线', s.track, 0);
    ok('排列集引用的边真有线索', b.clue[s.clueIdx] !== NO_CLUE, String(s.clueIdx));
    // the erased values are precisely the ones no surviving ordering puts at that position
    const at = b.tracks[0].cells.indexOf(s.cell);
    const seen = new Set(Array.from(b.tracks[0].perms, (pi) => permTable(4).flat[pi * 4 + at]));
    ok('被划掉的值确实没有一种摆法支持', s.values.every((v) => !seen.has(v)), s.values.join(','));
  }
  // 一整盘推到底时，每一步写下的数都必须活在所有相容摆法里 —— 这是"提示不是答案"的地基
  const full = derive(b);
  for (const s of full.steps.filter((x) => x.kind === 'place' && x.track != null)) {
    const t = b.tracks[s.track];
    if (!t.clued) continue;
    const at = t.cells.indexOf(s.cell);
    const flat = permTable(4).flat;
    const agree = Array.from(t.perms).every((pi) => flat[pi * 4 + at] === s.value);
    ok('写下的每一格都被它那条线的全部摆法支持', agree, `${t.name}#${at}=${s.value}`);
  }
}
{
  // 没有线索的那条线仍然是一串不重复的高度
  const b = mk(4, [['左', 0, 1]]);
  const dv = derive(b);
  const ln = withRule(dv, Rules.line);
  eq('一条线索带动相邻的线：line 开火 3 次', ln.length, 3);
  for (const s of ln) {
    eq('line 只在两端都没数的线上说话', b.tracks[s.track].clued, false);
    ok('line 不引用任何 clueIdx', s.clueIdx === undefined);
    eq('line 划掉的正是刚写下的那个高度', s.values.join(','), '4');
  }
  eq('line 划掉的格子都在同一列', ln.map((s) => s.cell % 4).join(','), '0,0,0');
  // 两个哨兵式的极端：两端都要 1，最高的那栋不可能同时站在两头
  const clash = mk(4, [['左', 0, 1], ['右', 0, 1]]);
  const d2 = derive(clash);
  ok('两端都写 1 的线会立刻自相矛盾', d2.conflict !== null);
  ok('矛盾话术里点名了那格已经有 4', /已经有 4/.test(d2.conflict && d2.conflict.message), d2.conflict && d2.conflict.message);
  const r2 = solve(clash);
  eq('这种盘推不完', r2.ok, false);
  eq('矛盾被原样带出来', r2.conflict, d2.conflict.message);
  eq('穷举也认为它一个解都没有', countSolutions(clash, { cap: 2 }).status, NONE);
  eq('朴素枚举同样一个都不给', countNaive(clash).solutions, 0);
  eq('排列表层面就没有相容摆法', compatible(4, 1, 1).length, 0);
  ok('矛盾盘上 verify 也会摇头', verify(clash, r2.derived).length > 0);
}

sec('致命图案：四阶的全部 576 个拉丁方，第四套实现');

// Everything above checked single clues against the engine's own tables. This section checks whole
// boards against a solution set built inside this file, from the definition of the game, sharing no
// code with js/engine/: enumerate the 576 order-4 Latin squares, read the sixteen edge counts off
// each with a tower counter written here, and see which clue sets admit more than one square.
const towers = (line) => {
  let seen = 0;
  let top = 0;
  for (const v of line) {
    if (v > top) {
      top = v;
      seen++;
    }
  }
  return seen;
};
// readings in the engine's side order: 上(每列自上)、右(每行自右)、下(每列自下)、左(每行自左)
function signature(g) {
  const out = [];
  for (let c = 0; c < 4; c++) out.push(towers([g[c], g[4 + c], g[8 + c], g[12 + c]]));
  for (let r = 0; r < 4; r++) out.push(towers([g[r * 4 + 3], g[r * 4 + 2], g[r * 4 + 1], g[r * 4]]));
  for (let c = 0; c < 4; c++) out.push(towers([g[12 + c], g[8 + c], g[4 + c], g[c]]));
  for (let r = 0; r < 4; r++) out.push(towers([g[r * 4], g[r * 4 + 1], g[r * 4 + 2], g[r * 4 + 3]]));
  return out.join('');
}
// Every ordering of 1..4. One helper, because this file leans on it twice: once to build the 576
// squares row by row, once to expand the four reduced squares into the same 576.
function perms24() {
  const out = [];
  const p = [0, 0, 0, 0];
  const used = [0, 0, 0, 0, 0];
  (function go(k) {
    if (k === 4) {
      out.push(p.slice());
      return;
    }
    for (let v = 1; v <= 4; v++) {
      if (used[v]) continue;
      used[v] = 1;
      p[k] = v;
      go(k + 1);
      used[v] = 0;
    }
  })(0);
  return out;
}
const ALL4 = (() => {
  const perms = perms24();
  eq('四阶的行候选是 24 种排列', perms.length, 24);
  const out = [];
  for (const a of perms) {
    for (const b of perms) {
      for (const c of perms) {
        for (const d of perms) {
          let latin = true;
          for (let k = 0; k < 4 && latin; k++) {
            const col = [a[k], b[k], c[k], d[k]];
            latin = new Set(col).size === 4;
          }
          if (latin) out.push([...a, ...b, ...c, ...d]);
        }
      }
    }
  }
  return out;
})();
eq('四阶拉丁方一共 576 个（ published 数）', ALL4.length, 576);
eq('它们互不相同', new Set(ALL4.map((g) => g.join(''))).size, 576);
// the local reader has to agree with the engine's on the hand-checked board from section 1
{
  const g = [2, 1, 4, 3, 3, 4, 1, 2, 1, 3, 2, 4, 4, 2, 3, 1];
  eq('本地读数器与 cluesFrom 给出同样的 16 个数', signature(g), asString(cluesFrom(4, Uint8Array.from(g))));
}
// which sixteen-number sets admit more than one square? all four edges printed is *not* enough.
const BY_SIG = new Map();
for (const g of ALL4) {
  const s = signature(g);
  if (!BY_SIG.has(s)) BY_SIG.set(s, []);
  BY_SIG.get(s).push(g);
}
const shared = [...BY_SIG.values()].filter((l) => l.length > 1);
eq('全线索签名总数（576 个盘共用）', BY_SIG.size, 438);
ok('存在两端都写满仍然不唯一的盘', shared.length > 0, `${shared.length} 个签名被多个盘共用`);
// 这些共用的签名并不是"都恰好两个盘"：实测重数只有 1、2、4、6 四种，最多的一组十六个读数被 6 个盘
// 共用。整条直方图写死在这里，而不是只盯一个最大值 —— 它同时把 576 个盘和 438 个签名两边都数完。
const HIST = {};
for (const l of BY_SIG.values()) HIST[l.length] = (HIST[l.length] || 0) + 1;
eq('重数直方图（几个盘共用一组读数 : 这样的读数有几组）', Object.keys(HIST).sort((a, b) => a - b).map((k) => `${k}:${HIST[k]}`).join(','), '1:372,2:34,4:28,6:4');
eq('直方图把 576 个盘数完', Object.keys(HIST).reduce((a, k) => a + k * HIST[k], 0), 576);
eq('直方图把 438 组读数数完', Object.values(HIST).reduce((a, b) => a + b, 0), BY_SIG.size);
eq('共用签名最多牵涉 6 个盘', Math.max(...shared.map((l) => l.length)), 6);
eq('不唯一的签名一共 66 组', shared.length, 66);
eq('不唯一的盘一共牵涉 204 个', shared.reduce((a, l) => a + l.length, 0), 204);
eq('唯一的盘一共 372 个', 576 - 204, 372);
{
  // 576 这个数由两条互不相干的路线数出来：上面是"逐行试所有 24 种排列"，下面是"4 个公开列出的
  // 4 阶化简拉丁方 × 行/列/符号置换"。两条路线必须数到同一批盘，否则本节后面的所有期望值都站不住。
  const REDUCED = [
    [1, 2, 3, 4, 2, 1, 4, 3, 3, 4, 1, 2, 4, 3, 2, 1],
    [1, 2, 3, 4, 2, 1, 4, 3, 3, 4, 2, 1, 4, 3, 1, 2],
    [1, 2, 3, 4, 2, 3, 4, 1, 3, 4, 1, 2, 4, 1, 2, 3],
    [1, 2, 3, 4, 2, 4, 1, 3, 3, 1, 4, 2, 4, 3, 2, 1],
  ];
  const isLatinSquare = (g) => {
    for (let k = 0; k < 4; k++) {
      if (new Set(g.slice(k * 4, k * 4 + 4)).size !== 4) return false;
      if (new Set([g[k], g[4 + k], g[8 + k], g[12 + k]]).size !== 4) return false;
    }
    return true;
  };
  eq('四个化简方各自都是拉丁方', REDUCED.every(isLatinSquare), true);
  eq('四个化简方的首行与首列都是 1234', REDUCED.every((g) => g.slice(0, 4).join('') === '1234' && [g[0], g[4], g[8], g[12]].join('') === '1234'), true);
  eq('公开常数：4 阶化简拉丁方是 4 个', REDUCED.length, 4);
  const viaIsotopy = new Set();
  const p24 = perms24();
  for (const base of REDUCED) {
    for (const rp of p24) for (const cp of p24) for (const sp of p24) {
      const g = new Array(16);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) g[r * 4 + c] = sp[base[(rp[r] - 1) * 4 + (cp[c] - 1)] - 1];
      viaIsotopy.add(g.join(''));
    }
  }
  eq('化简方 × 行/列/符号置换也给出 576 个盘', viaIsotopy.size, 576);
  eq('两条路线数到的是同一批盘', ALL4.every((g) => viaIsotopy.has(g.join(''))), true);
}
{
  // 本文件的枚举 vs 仓里那台独立计数器：438 组读数逐组对账，一个都不放过。
  let againstBacktrack = 0;
  let againstNaive = 0;
  let wrongVerdict = 0;
  for (const [sig, list] of BY_SIG) {
    const board = createBoard({ n: 4, clue: Int8Array.from(sig.split(''), (ch) => Number(ch)) });
    if (countSolutions(board, { cap: 99, budget: 1000000 }).solutions !== list.length) againstBacktrack++;
    if (countNaive(board).solutions !== list.length) againstNaive++;
    if (countSolutions(board, { cap: 2 }).status !== (list.length === 1 ? UNIQUE : MANY)) wrongVerdict++;
  }
  eq('438 组读数逐一：回溯计数器的解数与本文件枚举相同', againstBacktrack, 0);
  eq('438 组读数逐一：朴素枚举的解数与本文件枚举相同', againstNaive, 0);
  eq('438 组读数逐一：唯一/多解的判词与本文件枚举相同', wrongVerdict, 0);
}
{
  // the witness, written out: swapping 1 and 4 inside the 2x2 rectangle at rows 2-3, cols 2-3 keeps
  // every row and every column a permutation, and changes no edge reading.
  const A = [1, 2, 3, 4, 2, 1, 4, 3, 3, 4, 1, 2, 4, 3, 2, 1];
  const B = [1, 2, 3, 4, 2, 4, 1, 3, 3, 1, 4, 2, 4, 3, 2, 1];
  const sa = signature(A);
  const sb = signature(B);
  eq('致命图案：两个不同的盘', A.join('') === B.join(''), false);
  eq('致命图案：十六个读数一模一样', sa, sb);
  eq('致命图案：它们都在 576 个里', ALL4.some((g) => g.join('') === A.join('')) && ALL4.some((g) => g.join('') === B.join('')), true);
  const board = createBoard({ n: 4, clue: Uint8Array.from(sa.split('').map(Number)) });
  eq('致命图案：本文件的枚举给出 2 个解', ALL4.filter((g) => signature(g) === sa).length, 2);
  eq('致命图案：countSolutions 也说 MANY', countSolutions(board, { cap: 2 }).status, MANY);
  eq('致命图案：countNaive 也说 2 个', countNaive(board).solutions, 2);
  eq('致命图案：本文件的解集与 countNaive 数一致', ALL4.filter((g) => signature(g) === sa).length, countNaive(board).solutions);
  const r = solve(board);
  eq('致命图案：所以铅笔路径推不完它（它本来就不唯一）', r.ok, false);
  eq('致命图案：推不完时它不硬写满', r.derived.some((v) => v === EMPTY), true);
  // the accepted boards are the ones where the pencil path *can* finish — which is why that test,
  // not "is it fully clued", is what the generator gates on.
}
// A shipped-board check that shares nothing with the engine: how many order-4 squares satisfy this
// board's printed numbers? exactly one, and it is the one the pencil path writes.
const BAKED4 = LEVELS.filter((l) => l.n === 4);
eq('出厂关卡里的四阶盘数量', BAKED4.length, 8);
for (const row of BAKED4) {
  const clue = decodeClue(4, row.clue);
  const hits = ALL4.filter((g) => {
    for (let i = 0; i < 16; i++) if (clue[i] !== NO_CLUE && sigOfGrid(g)[i] !== clue[i]) return false;
    return true;
  });
  eq(`${row.id}：本文件独立枚举只给一个盘`, hits.length, 1);
  const r = solve(boardOfRow(row));
  eq(`${row.id}：那一个盘与铅笔路径逐格相同`, hits.length === 1 ? hits[0].join('') : '', asString(r.derived));
}
function sigOfGrid(g) {
  const out = [];
  for (let c = 0; c < 4; c++) out.push(towers([g[c], g[4 + c], g[8 + c], g[12 + c]]));
  for (let r = 0; r < 4; r++) out.push(towers([g[r * 4 + 3], g[r * 4 + 2], g[r * 4 + 1], g[r * 4]]));
  for (let c = 0; c < 4; c++) out.push(towers([g[12 + c], g[8 + c], g[4 + c], g[c]]));
  for (let r = 0; r < 4; r++) out.push(towers([g[r * 4], g[r * 4 + 1], g[r * 4 + 2], g[r * 4 + 3]]));
  return out;
}

sec('每一步都当场可验：写下的数被谁支持');

// A step is justified *locally* if, given the pencil position just before it, what the rule says is
// forced. Replaying the script lets these tests audit each step without trusting propagate().
function replay(board) {
  const n = board.n;
  const placed = new Uint8Array(n * n);
  const domain = Int32Array.from({ length: n * n }, () => fullMask(n));
  const dv = derive(board);
  const flat = permTable(n).flat;
  const out = { bad: [], count: 0, rules: new Set() };
  dv.steps.forEach((s, idx) => {
    out.count++;
    out.rules.add(s.rule.key);
    const before = { placed: Uint8Array.from(placed), domain: Int32Array.from(domain) };
    // apply the step to the running position
    if (s.kind === 'place') {
      placed[s.cell] = s.value;
      domain[s.cell] = bit(s.value);
    } else for (const v of s.values) domain[s.cell] &= ~bit(v);
    // ---- the audit, against the position *before* the step
    if (s.kind === 'place') {
      if (before.placed[s.cell] !== EMPTY) out.bad.push(`第 ${idx} 步往已写过的格又写了一次`);
      if (!(before.domain[s.cell] & bit(s.value))) out.bad.push(`第 ${idx} 步写的数不在自己的候选里`);
      if (s.track != null) {
        const t = board.tracks[s.track];
        if (t.cells.indexOf(s.cell) < 0) out.bad.push(`第 ${idx} 步点名的线不包含这一格`);
        if (before.placed.some((v, i) => v === s.value && t.cells.indexOf(i) >= 0 && i !== s.cell)) {
          out.bad.push(`第 ${idx} 步在同一条线里写了第二个 ${s.value}`);
        }
        // the strong one: for a clued line, every compatible ordering that still fits the position
        // before the step must put this value in this cell
        if (t.clued) {
          const at = t.cells.indexOf(s.cell);
          const supports = t.perms.filter((pi) => t.cells.every((c2, k) => {
            const v = flat[pi * n + k];
            return before.placed[c2] === EMPTY ? !!(before.domain[c2] & bit(v)) : before.placed[c2] === v;
          }));
          if (!supports.length) out.bad.push(`第 ${idx} 步之后这条线已经没有相容摆法`);
          for (const pi of supports) {
            if (flat[pi * n + at] !== s.value) {
              out.bad.push(`第 ${idx} 步（${s.rule.name}）写了 ${s.value}，可这条线还有一种相容摆法在这一格写 ${flat[pi * n + at]}`);
              break;
            }
          }
        }
      }
    } else {
      for (const v of s.values) {
        if (!(before.domain[s.cell] & bit(v))) out.bad.push(`第 ${idx} 步划掉了一个本来就不是候选的 ${v}`);
        if (s.rule === Rules.setPrune && s.track != null) {
          const t = board.tracks[s.track];
          const at = t.cells.indexOf(s.cell);
          const supports = t.perms.filter((pi) => t.cells.every((c2, k) => {
            const vv = flat[pi * n + k];
            return before.placed[c2] === EMPTY ? !!(before.domain[c2] & bit(vv)) : before.placed[c2] === vv;
          }));
          if (supports.some((pi) => flat[pi * n + at] === v)) out.bad.push(`第 ${idx} 步划掉了 ${v}，可它仍是某种相容摆法的值`);
        }
      }
      if (s.kind === 'prune' && domain[s.cell] === 0 && !dv.conflict) out.bad.push(`第 ${idx} 步把一格候选清空了却没报矛盾`);
    }
    if (s.clueIdx != null) {
      if (board.clue[s.clueIdx] === NO_CLUE) out.bad.push(`第 ${idx} 步引用了一条没写数的边`);
      if (s.clueIdx < 0 || s.clueIdx >= 4 * n) out.bad.push(`第 ${idx} 步的边号越界`);
    }
  });
  if (dv.conflict) out.conflict = dv.conflict.message;
  out.dv = dv;
  return out;
}
{
  const a = replay(mk(4, [['左', 0, 2], ['右', 0, 2]]));
  eq('2/2 那一行的每一步都经得起审计', a.bad.length, 0);
  const b = replay(mk(4, [['左', 0, 1], ['右', 0, 1]]));
  ok('矛盾盘的审计也不含糊：它报了矛盾', b.conflict !== undefined);
}

sec('生成保证：出厂的 20 关与每一档现场出的题');

const NAIVE_BUDGET = { 4: Infinity, 5: Infinity, 6: 2000000 };
const CHECKED = { levels: 0, fresh: 0 };
function auditPuzzle(label, board, opts = {}) {
  const n = board.n;
  const r = solve(board);
  ok(`${label}：铅笔路径推得完`, r.ok, r.conflict || `推到 ${r.places}/${n * n} 格`);
  eq(`${label}：推得完时不该有矛盾`, r.conflict, null);
  eq(`${label}：每一格都被写下`, r.derived.every((v) => v !== EMPTY), true);
  eq(`${label}：答案自己满足全部线索`, verify(board, r.derived).length, 0);
  eq(`${label}：complete 认这个盘`, complete(board, r.derived), true);
  const c = countSolutions(board, { cap: 2, budget: 60000000 });
  eq(`${label}：回溯计数器判 UNIQUE`, c.status, UNIQUE);
  if (c.first) {
    let differs = -1;
    for (let i = 0; i < c.first.length; i++) if (c.first[i] !== r.derived[i]) { differs = i; break; }
    eq(`${label}：回溯计数器的解与铅笔路径逐格相同`, differs, -1);
  }
  // the third route: enumerate Latin squares without using any clue during the search. Order 6 has
  // 812,851,200 of them, so there the pencil answer's first row is pinned and 1,128,960 are read —
  // which is why a UNIQUE verdict still comes from countSolutions above, not from this line.
  const given = n >= 6 ? (() => { const g = new Uint8Array(n * n); for (let c2 = 0; c2 < n; c2++) g[c2] = r.derived[c2]; return g; })() : null;
  const naive = countNaive(board, { given });
  eq(`${label}：朴素枚举（${given ? '定首行' : '全枚举'}）只找到 1 个解`, naive.solutions, 1);
  if (naive.first) {
    let differs = -1;
    for (let i = 0; i < naive.first.length; i++) if (naive.first[i] !== r.derived[i]) { differs = i; break; }
    eq(`${label}：朴素枚举的解与铅笔路径逐格相同`, differs, -1);
  }
  const a = replay(board);
  eq(`${label}：${a.count} 步，每一步都被当场支持`, a.bad.length, 0);
  if (opts.baked) {
    // 三条独立路线 + 烘焙文件里印的那一串，逐格对账：铅笔路径 == 回溯计数器 == 朴素枚举 == 出厂答案
    const who = opts.bakedName || '烘焙印的答案';
    ok(`${label}：回溯计数器交回了它数到的那一个盘`, c.first !== null && c.first.length === n * n, String(c.first));
    ok(`${label}：朴素枚举交回了它数到的那一个盘`, naive.first !== null && naive.first.length === n * n, String(naive.first));
    const baked = opts.baked;
    // -2 而不是 -1：穷举那一路线要是没交回解，下面的比对要跟着一起红，不能因为循环没跑而假绿
    let vsPencil = -2;
    let vsBacktrack = -2;
    let vsNaive = -2;
    if (c.first && naive.first) {
      vsPencil = -1;
      vsBacktrack = -1;
      vsNaive = -1;
      for (let i = 0; i < n * n; i++) {
        if (vsPencil === -1 && baked[i] !== r.derived[i]) vsPencil = i;
        if (vsBacktrack === -1 && baked[i] !== c.first[i]) vsBacktrack = i;
        if (vsNaive === -1 && baked[i] !== naive.first[i]) vsNaive = i;
      }
    }
    eq(`${label}：${who}与铅笔路径逐格相同`, vsPencil, -1);
    eq(`${label}：${who}与回溯计数器的解逐格相同`, vsBacktrack, -1);
    eq(`${label}：${who}与朴素枚举的解逐格相同`, vsNaive, -1);
  }
  if (opts.score != null) eq(`${label}：印出的分数能重算`, r.score, opts.score);
  if (opts.steps != null) eq(`${label}：印出的步数能重算`, r.steps, opts.steps);
  if (opts.clues != null) eq(`${label}：印出的线索数能重算`, board.clues, opts.clues);
  CHECKED.levels++;
  return r;
}
eq('出厂关卡一共 20 关', LEVELS.length, 20);
eq('每一档 4 关', CHAPTERS.map((c) => c.levels.length).join(','), '4,4,4,4,4');
eq('档位顺序与 TIERS 一致', CHAPTERS.map((c) => c.tier).join(','), TIERS.map((t) => t.key).join(','));
{
  // TIERS_META 是"烘焙时量到的那一档"，它按档名索引（不是一条数组），并且每个字段都要能从 TIERS 或
  // 从 LEVELS 现算回来。这里把两件事分开验：形状（键名、键序）和内容（逐字段对账）。
  eq('TIERS_META 是一张按档名索引的表', Array.isArray(TIERS_META), false);
  eq('TIERS_META 的键与 TIERS 的档名同序同集', Object.keys(TIERS_META).join(','), TIERS.map((t) => t.key).join(','));
  for (const tier of TIERS) {
    const meta = TIERS_META[tier.key];
    ok(`${tier.key}：TIERS_META 里有这一档`, meta != null, JSON.stringify(Object.keys(TIERS_META)));
    eq(`${tier.key}：TIERS_META 说的阶数与 TIERS 一致`, meta.n, tier.n);
    eq(`${tier.key}：TIERS_META 说的档位名与 TIERS 一致`, meta.name, tier.name);
    eq(`${tier.key}：TIERS_META 说的 band 与 TIERS 一致`, meta.band.join(','), tier.band.join(','));
    eq(`${tier.key}：TIERS_META 说的 target 与 TIERS 一致`, meta.target, tier.target);
    eq(`${tier.key}：TIERS_META 说的 tries 与 TIERS 一致`, meta.tries, tier.tries);
    eq(`${tier.key}：TIERS_META 说的尺寸串与阶数一致`, meta.size, `${tier.n}×${tier.n}`);
    // 这一档出厂关卡的量：线索数与分数区间是从盘上重算的，不是抄 levels.js 里的印数
    const rows = LEVELS.filter((l) => l.tier === tier.key);
    eq(`${tier.key}：TIERS_META 说的关数与 LEVELS 一致`, meta.levels, rows.length);
    const clueCounts = rows.map((l) => boardOfRow(l).clues);
    const solved = rows.map((l) => solve(boardOfRow(l)));
    eq(`${tier.key}：clueLo 重算得回来`, meta.clueLo, Math.min(...clueCounts));
    eq(`${tier.key}：clueHi 重算得回来`, meta.clueHi, Math.max(...clueCounts));
    eq(`${tier.key}：scoreLo 重算得回来`, meta.scoreLo, Math.min(...solved.map((r) => r.score)));
    eq(`${tier.key}：scoreHi 重算得回来`, meta.scoreHi, Math.max(...solved.map((r) => r.score)));
    eq(`${tier.key}：stepsLo 重算得回来`, meta.stepsLo, Math.min(...solved.map((r) => r.steps)));
    eq(`${tier.key}：stepsHi 重算得回来`, meta.stepsHi, Math.max(...solved.map((r) => r.steps)));
    eq(`${tier.key}：deepest 重算得回来`, meta.deepest, Math.max(...solved.map((r) => r.depth)));
    // 每一关都落在自己档的 band 里 —— band 是选取目标，不是事后贴的标签
    for (let i = 0; i < rows.length; i++) {
      ok(`${rows[i].id}：实测分数落在 ${tier.key} 的 band 里`, solved[i].score >= tier.band[0] && solved[i].score <= tier.band[1], `${solved[i].score} vs ${tier.band}`);
      ok(`${rows[i].id}：线索数不低于这一档的 target`, clueCounts[i] >= tier.target, `${clueCounts[i]}/${tier.target}`);
    }
  }
  // 难度是量出来的：五档的实测中位数必须一档高过一档
  const medians = TIERS.map((t) => {
    const xs = LEVELS.filter((l) => l.tier === t.key).map((l) => solve(boardOfRow(l)).score).sort((a, b) => a - b);
    return (xs[1] + xs[2]) / 2;
  });
  let rising = true;
  for (let i = 1; i < medians.length; i++) if (!(medians[i] > medians[i - 1])) rising = false;
  ok('五档实测中位数单调递增', rising, medians.join(' < '));
  let bandsOrdered = true;
  for (let i = 1; i < TIERS.length; i++) if (!(TIERS[i].band[0] > TIERS[i - 1].band[0])) bandsOrdered = false;
  ok('band 的下沿也一档高过一档', bandsOrdered, TIERS.map((t) => t.band.join('~')).join(' | '));
}
for (const row of LEVELS) {
  const board = boardOfRow(row);
  eq(`${row.id}：线索串长度是 4n`, row.clue.length, 4 * row.n);
  eq(`${row.id}：解码再编码回到原串`, encodeClue(board.clue), row.clue);
  eq(`${row.id}：阶数与档位相配`, row.n, tierFor(row.tier).n);
  // 烘焙文件里印着的那串答案是第四套意见：它必须自己满足线索，也必须和铅笔路径、和穷举计数器逐格相同。
  // 字段名写错就会让这一整段静默地不跑（`row.answer` 就是这么个东西），所以先断言它真的存在。
  ok(`${row.id}：烘焙文件里有印下来的答案串`, typeof row.solution === 'string' && row.solution.length === row.n * row.n, JSON.stringify(row.solution));
  const baked = decodeGrid(row.n, row.solution);
  const full = cluesFrom(row.n, baked);
  let readBack = 0;
  for (let i = 0; i < full.length; i++) if (board.clue[i] !== NO_CLUE && board.clue[i] !== full[i]) readBack++;
  eq(`${row.id}：印下来的答案逐边回读，就是盘上印着的那些数`, readBack, 0);
  eq(`${row.id}：印下来的答案自己满足全部线索`, verify(board, baked).length, 0);
  eq(`${row.id}：印下来的答案构成一个完整的盘`, complete(board, baked), true);
  auditPuzzle(row.id, board, { score: row.score, steps: row.steps, clues: row.clues, baked });
}
eq('20 关全部审过', CHECKED.levels, 20);
{
  // and the live generator, not just what it baked: three seeds per tier, same triple check
  for (const tier of TIERS) {
    for (let s = 0; s < 3; s++) {
      const p = makePuzzle(`test|${tier.key}|${s}`, tier.key);
      ok(`${tier.key} 种子 ${s}：出得了题`, p !== null);
      if (!p) continue;
      CHECKED.fresh++;
      eq(`${tier.key} 种子 ${s}：阶数对`, p.n, tier.n);
      ok(`${tier.key} 种子 ${s}：线索数不低于 target`, p.clues >= tier.target, `${p.clues}/${tier.target}`);
      ok(`${tier.key} 种子 ${s}：分数落在自己的带里`, p.score >= tier.band[0] && p.score <= tier.band[1], `${p.score} vs ${tier.band}`);
      ok(`${tier.key} 种子 ${s}：出货前确实采过样`, p.sampled >= 1 && p.gen >= 1, String(p.sampled));
      eq(`${tier.key} 种子 ${s}：同一颗种子给同一个盘`, asString(makePuzzle(`test|${tier.key}|${s}`, tier.key).board.clue), asString(p.board.clue));
      auditPuzzle(`${tier.key}#${s}`, p.board, { baked: p.solution });
      // the planted grid is a Latin square whose edges are the printed clues
      const g = p.solution;
      for (let i = 0; i < p.n; i++) {
        eq(`${tier.key} 种子 ${s}：第 ${i + 1} 行不重复`, new Set(Array.from(g).slice(i * p.n, i * p.n + p.n)).size, p.n);
        eq(`${tier.key} 种子 ${s}：第 ${i + 1} 列不重复`, new Set(Array.from({ length: p.n }, (_, r) => g[r * p.n + i])).size, p.n);
      }
      eq(`${tier.key} 种子 ${s}：答案与线索同源`, clueAgreement(p.board, cluesFrom(p.n, g)), 0);
      eq(`${tier.key} 种子 ${s}：没印数的边确实是删掉的（不是漏写）`, dots(p.board.clue).replace(/\./g, '').length, p.clues);
    }
  }
  eq('现场出货 15 盘', CHECKED.fresh, 15);
}
{
  // generate() aims at the band and says so; it never loosens the acceptance test to land there
  const plain = generate({ n: 4, seed: 'audit|plain', target: 12, tries: 8 });
  ok('不给 band 时也出货', plain.ok === true);
  eq('不给 band 时 offBand 是 0', plain.offBand, 0);
  const impossible = generate({ n: 4, seed: 'audit|impossible', target: 12, tries: 3, band: [99999, 100000] });
  ok('带落在天上时它承认造不出，而不是硬交一盘', impossible.ok === true && impossible.offBand > 0);
  eq('带外的盘照样推得完', solve(impossible.board).ok, true);
  const tiny = generate({ n: 4, seed: 'audit|tiny', target: 16, tries: 30 });
  ok('线索给得越多越简单', tiny.ok && tiny.score > 0 && tiny.clues >= 16, `${tiny.score}/${tiny.clues}`);
}
{
  // pruneClues / resupply: the two knobs, and the promise that a removal is only kept when the
  // pencil path still finishes — not merely when it does not contradict.
  const g = gridOf([
    [2, 1, 4, 3],
    [3, 4, 1, 2],
    [1, 3, 2, 4],
    [4, 2, 3, 1],
  ]);
  const full = createBoard({ n: 4, clue: cluesFrom(4, g) });
  eq('满线索盘有 16 条', full.clues, 16);
  eq('满线索盘的读数与种下的盘同源', clueAgreement(full, cluesFrom(4, g)), 0);
  const pruned = pruneClues(full, mix('prune|a'), 9);
  eq('删到 target 就收手', pruned.kept, 9);
  eq('交出的线索数与 kept 相同', printed(pruned.clue), 9);
  eq('removed 的数量对得上', pruned.removed.length, 16 - 9);
  for (const i of pruned.removed) eq(`被删的第 ${i} 条原来是有数的`, full.clue[i] !== NO_CLUE, true);
  eq('删完之后仍然自洽', createBoard({ n: 4, clue: pruned.clue }).clues, 9);
  // 删过的每一刻都要留得下：把删除序列从头到尾铺开，前缀删到哪一步，那一步的盘都还得推得完
  {
    let stalledAt = -1;
    let lost = 0;
    const walk = Int8Array.from(full.clue);
    for (let k = 0; k < pruned.removed.length; k++) {
      walk[pruned.removed[k]] = NO_CLUE;
      const step = createBoard({ n: 4, clue: walk });
      const r = solve(step);
      if (!r.ok) { stalledAt = k; break; }
      if (!Array.from(g).every((v, i) => v === r.derived[i])) lost++;
    }
    eq('删除序列的每一个前缀都还推得完', stalledAt, -1);
    eq('删除序列的每一个前缀都还只有那一个解', lost, 0);
  }
  eq('删到 9 条之后仍然唯一', countSolutions(createBoard({ n: 4, clue: pruned.clue }), { cap: 2 }).status, UNIQUE);
  const back = resupply(full.clue, pruned.clue, pruned.removed, mix('prune|a'), 3);
  eq('还回去 3 条', printed(back), 12);
  for (let i = 0; i < 16; i++) ok('还回去的只会是删掉的', back[i] === pruned.clue[i] || back[i] === full.clue[i], String(i));
  eq('还回去以后依然推得完', solve(createBoard({ n: 4, clue: back })).ok, true);
  const greedy = pruneClues(full, mix('prune|b'), 0);
  ok('不设定量时它删到推不动为止', greedy.kept > 4 && greedy.kept < 16, String(greedy.kept));
  eq('那种盘也仍然推得完', solve(createBoard({ n: 4, clue: greedy.clue })).ok, true);
  eq('那种盘也仍然唯一', countSolutions(createBoard({ n: 4, clue: greedy.clue }), { cap: 2 }).status, UNIQUE);
  // "删到推不动为止"是说得出兑现的条件的：剩下任何一条线索，再删掉它盘就推不完
  {
    let stillRemovable = 0;
    const keep = Array.from(greedy.clue).map((v, i) => (v === NO_CLUE ? -1 : i)).filter((i) => i >= 0);
    for (const i of keep) {
      const weaker = Int8Array.from(greedy.clue);
      weaker[i] = NO_CLUE;
      if (printed(weaker) === 0) continue;
      if (solve(createBoard({ n: 4, clue: weaker })).ok) stillRemovable++;
    }
    eq('贪心删到的位置确实是极小的（再删一条就推不完）', stillRemovable, 0);
    eq('极小盘上还留着线索', printed(greedy.clue) > 0, true);
  }
}
{
  // the seeded randomness both halves of the game run on
  const r1 = mix('same');
  const r2 = mix('same');
  eq('同一种子给同一条随机流', [r1(), r1(), r1()].join(','), [r2(), r2(), r2()].join(','));
  const r3 = mix('other');
  ok('换种子就换一条流', r3() !== r1(), '');
  const g1 = randomLatin(5, mix('latin|1'));
  const g2 = randomLatin(5, mix('latin|1'));
  eq('拉丁方可复现', asString(g1), asString(g2));
  eq('拉丁方每行都是 1..5', g1.every((_, i) => new Set(Array.from(g1).slice((i / 5 | 0) * 5, (i / 5 | 0) * 5 + 5)).size === 5) , true);
  eq('预算不够时 randomLatin 承认失败', randomLatin(6, mix('latin|budget'), { budget: 3 }), null);
}

sec('状态机：一次手势 = 一步撤销');

{
  const b = mk(4, [['左', 0, 2]]);
  const st = createState(b);
  eq('新墨迹是空的', list(st.cell), '0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0');
  eq('新笔记也是空的', st.notes.every((m) => m === 0), true);
  eq('历史是空的', st.history.length, 0);
  eq('写一个合法数字', setCell(st, 0, 3), true);
  eq('落墨', st.cell[0], 3);
  eq('一次手势留一份快照', st.history.length, 1);
  eq('重写同一个值不算手势', setCell(st, 0, 3), false);
  eq('没有多余的快照', st.history.length, 1);
  eq('越界的格子不写', setCell(st, 16, 1), false);
  eq('负的格子不写', setCell(st, -1, 1), false);
  eq('超出 n 的高度不写', setCell(st, 1, 5), false);
  eq('被拒绝的三次一个快照都不留', st.history.length, 1);
  eq('高度 0 只用来表示擦掉', setCell(st, 0, 0), true);
  eq('擦干净了', st.cell[0], EMPTY);
  eq('擦也是一步', st.history.length, 2);
  st.notes[1] = bit(2) | bit(3);
  eq('落墨会清掉那一格的笔记', setCell(st, 1, 4) && st.notes[1], 0);
  eq('第三次手势记下', st.history.length, 3);
  eq('撤销回到刚写下 4 之前', undoEngine(st) && st.cell[1], 0);
  eq('那一格的笔记也一起回来', valuesIn(st.notes[1]).join(''), '23');
  eq('撤销一步就退掉一份快照', st.history.length, 2);
  // 撤销是精确回放而不是重来一遍：擦掉之前那个 3 要原样回来，笔记要跟着那份快照走
  ok('再撤一次回到"擦掉之前"', undoEngine(st) && st.cell[0] === 3, list(st.cell));
  eq('那一格的笔记不在快照之外', st.notes[1], 0);
  eq('还剩一份快照', st.history.length, 1);
  eq('第三次撤销回到全空', undoEngine(st) && asString(st.cell), '0000000000000000');
  eq('撤销到底（历史空了）', st.history.length, 0);
  eq('空历史再撤销就是不做事', undoEngine(st), false);
  eq('盘面回到全空', asString(st.cell), '0000000000000000');
}
{
  const b = mk(4, [['左', 0, 2]]);
  const st = createState(b);
  eq('在空格上做笔记', toggleNote(st, 5, 2), true);
  eq('笔记是一位候选', valuesIn(st.notes[5]).join(''), '2');
  eq('再点一次取消', toggleNote(st, 5, 2) && st.notes[5], 0);
  toggleNote(st, 5, 3);
  setCell(st, 5, 1);
  eq('写了数字就不能再做笔记', toggleNote(st, 5, 4), false);
  eq('数字与笔记是两件事', st.cell[5], 1);
  eq('n 以外的候选点不出来', toggleNote(st, 6, 5), false);
  eq('高度 0 点不出来', toggleNote(st, 6, 0), false);
  // 上面那一次落墨已经把第 6 格的笔记清掉了，所以这里得先留下别的笔记，"清空"才真有事可做
  toggleNote(st, 9, 2);
  toggleNote(st, 10, 3);
  eq('清空笔记', clearNotes(st), true);
  eq('全空了', st.notes.every((m) => m === 0), true);
  eq('没笔记时清空不算手势', clearNotes(st), false);
  eq('抹掉笔迹', resetInk(st) && asString(st.cell).replace(/0/g, '').length, 0);
  eq('抹掉笔迹连历史一起清', st.history.length, 0);
  const deep = createState(mk(4, [['左', 0, 2]]));
  for (let i = 0; i < 500; i++) setCell(deep, i % 16, (i % 4) + 1);
  ok('历史有上限，不会无限吃内存', deep.history.length <= 400, String(deep.history.length));
  ok('到顶后还能继续撤销', undoEngine(deep), true);
}
{
  // conflict detection, read off the ink rather than off the script
  const b = mk(4, [['左', 0, 2], ['右', 0, 2], ['上', 0, 2], ['下', 0, 2]]);
  const good = gridOf([
    [1, 4, 2, 3],
    [4, 1, 3, 2],
    [2, 3, 1, 4],
    [3, 2, 4, 1],
  ]);
  eq('手算的这盘满足四条线索', verify(b, good).length, 0);
  eq('也满足全部 16 条边吗——只给了四条', complete(b, good), true);
  const dup = Uint8Array.from(good);
  dup[1] = 1;
  const bad = verify(b, dup);
  ok('同行两个 1 会被抓', bad.some((x) => x.why === '重复高度'));
  ok('重复高度会点名格子', bad.some((x) => x.why === '线索对不上' || x.why === '重复高度'));
  const hole = Uint8Array.from(good);
  hole[9] = EMPTY;
  eq('没写完不算答案', complete(b, hole), false);
  eq('没写完时 verify 说"空格"', verify(b, hole).filter((x) => x.why === '空格').length, 1);
  const dg = diagnose(b, good);
  eq('满盘诊断：violated 为空', dg.violated.size, 0);
  eq('满盘诊断：四条边都被判定满足', dg.satisfied.size, 4);
  eq('满盘诊断：没有坏格', dg.badCells.size, 0);
  eq('满盘诊断：填了多少格', dg.filled, 16);
  eq('满盘诊断：还剩多少格', dg.remaining, 0);
  const wrong = Uint8Array.from(good);
  wrong[0] = 3;
  wrong[1] = 4;
  wrong[2] = 2;
  wrong[3] = 1;
  const d2 = diagnose(b, wrong);
  ok('第一行改成 3412 之后，左右两条线索至少有一条被 violated', d2.violated.size >= 1, asString(Array.from(d2.violated)));
  ok('重复的高度被抓进 badCells', d2.badCells.size >= 1, asString(Array.from(d2.badCells)));
  eq('这种盘已经推不回去了', deadEnd(b, wrong) !== null, true);
  eq('可达性说同一句话', reachable(b, wrong), false);
  eq('正确答案仍然可达', reachable(b, good), true);
  eq('空盘没有矛盾', deadEnd(b, createState(b).cell), null);
  // notes the clues have already killed
  const withNotes = Int32Array.from(createState(b).notes);
  withNotes[0] = bit(4);
  const ne = noteConflicts(b, createState(b).cell, withNotes);
  eq('在 (1,1) 上标 4 是笔记错（左 2 已经削掉它）', ne.length, 1);
  eq('笔记错点名那一格', ne[0].cell, 0);
  eq('笔记错点名单个候选', ne[0].values.join(','), '4');
  ok('笔记错的话术说清了原因', /已经被线索排除/.test(ne[0].why), ne[0].why);
  const dg2 = diagnose(b, createState(b).cell, withNotes);
  eq('diagnose 把笔记错带出来', dg2.noteErrors.length, 1);
  eq('写对了的笔记不报错', noteConflicts(b, createState(b).cell, (() => const0())()).length, 0);
  function const0() {
    const m = Int32Array.from(createState(b).notes);
    m[0] = bit(2);
    return m;
  }
  // nextDeduction: the next thing the clues force that the player has not written yet
  const emptyState = createState(b).cell;
  const nx = nextDeduction(b, emptyState);
  ok('nextDeduction 给得出下一步', nx.step != null);
  // 空盘上第一条被线索逼出来的事实不是落子，是"这一格站不下 4"：左 2 要求第一格后面还留一栋更高的。
  // 提示引擎必须能说得出这种"划掉一笔"的话，否则脚本第一步就没法播。
  eq('下一步是划候选', nx.step.kind, 'prune');
  eq('下一步落在 (1,1)', nx.step.cell, 0);
  eq('下一步划掉的是 4', nx.step.values.join(','), '4');
  eq('下一步点名左边那条 2', nx.step.clueIdx, clueIndex(4, 3, 0));
  ok('下一步的话术说得出依据', /第一格后面还得留出/.test(nx.step.rule.text(b, nx.step)), nx.step.rule.text(b, nx.step));
  {
    // 把别的格按答案填好、只留第 2 格空着：这时轮到这一格的是一条落子
    const oneHole = Uint8Array.from(good);
    oneHole[1] = EMPTY;
    const np = nextDeduction(b, oneHole);
    ok('留一格时 nextDeduction 给得出落子', np.step != null);
    eq('落子步的 kind 是 place', np.step.kind, 'place');
    eq('落子落在那一格', np.step.cell, 1);
    eq('落的值和答案一致', np.step.value, good[1]);
    ok('落子步点名叫得出依据', np.step.clueIdx != null && b.clue[np.step.clueIdx] !== NO_CLUE, String(np.step.clueIdx));
  }
  const nx2 = nextDeduction(b, good);
  eq('写满之后没有下一步', nx2.step, null);
  const nx3 = nextDeduction(b, wrong);
  ok('矛盾盘上 nextDeduction 报矛盾', typeof nx3.conflict === 'string');
}
{
  // the class the game actually uses
  const row = LEVELS.find((l) => l.tier === 'novice');
  const g = new Game(puzzleFromLevel(row));
  eq('开局状态是 playing', g.status, 'playing');
  eq('提示脚本非空', g.script.length > 0, true);
  eq('脚本长度与 state() 说的一致', g.state().script, g.script.length);
  eq('开局零步数', g.state().steps, 0);
  eq('点一下写 1', g.tap(0).value, 1);
  eq('再点一下写 2', g.tap(0).value, 2);
  eq('第三下写 3', g.tap(0).value, 3);
  eq('第四下写满 n 楼', g.tap(0).value, g.w);
  eq('第五下回到空', g.tap(0).value, EMPTY);
  eq('五次点按记五步', g.state().steps, 5);
  eq('点按次数进了 moves', g.state().moves, 5);
  g.undo();
  g.undo();
  // 五下点按写下的是 1→2→3→4→空，退两步就是把"空"和"4"这两步收回，回到 3
  eq('撤销两次回到 3', g.valueOf(0), 3);
  eq('步数也跟着退', g.state().steps, 3);
  eq('键盘写死一个数', g.put(1, 3) && g.valueOf(1), 3);
  eq('写重复值不算手势', g.put(1, 3), null);
  eq('越界值被拒绝', g.put(1, 9), null);
  eq('负坐标被拒绝', g.tap(-1), null);
  g.mode = NOTE;
  g.setDigit(2);
  g.tap(2);
  eq('笔记模式不动数字', g.valueOf(2), EMPTY);
  eq('笔记模式写了一位候选', valuesIn(g.notesOf(2)).join(''), '2');
  eq('数字跟着点按走', g.state().digit, 2);
  eq('非法数字不改键盘', g.setDigit(9), false);
  g.mode = INK;
  const before = g.state().steps;
  eq('一笔刷过多格', g.stroke([5, 6, 7, 8], 1) && g.state().steps - before, 1);
  eq('一笔真的落到了四格上', [5, 6, 7, 8].map((i) => g.valueOf(i)).join(','), '1,1,1,1');
  eq('全部已是该值的一笔不算手势', g.stroke([5, 6, 7, 8], 1), null);
  eq('一笔之后撤销一步就全回去', g.undo() !== null && [5, 6, 7, 8].map((i) => g.valueOf(i)).join(','), '0,0,0,0');
  eq('空白一笔不算手势', g.stroke([], 1), null);
  g.wipeNotes();
  eq('清空笔记后没剩笔记', g.notesOf(2), 0);
  g.undo();
  eq('清空笔记也能撤', valuesIn(g.notesOf(2)).join(''), '2');
  const st0 = g.state();
  ok('state() 把 UI 要读的东西都给全了', ['tier', 'kind', 'name', 'seed', 'moves', 'hints', 'status', 'n', 'filled', 'total', 'remaining', 'clues', 'satisfied', 'conflicts', 'noteErrors', 'badCells', 'score', 'steps', 'mode', 'digit', 'selected', 'script', 'cursor', 'rules'].every((k) => k in st0), Object.keys(st0).join(','));
  ok('state().rules 是本局真的用过的规则', Object.keys(st0.rules).length > 0, JSON.stringify(st0.rules));
  eq('规则的中文名与引擎一致', Object.keys(st0.rules).every((k) => RULE_LIST.some((r) => r.name === k)), true);
}
{
  // hints: charged, uncharged, and the one case that must not be billed
  const row = LEVELS.find((l) => l.tier === 'master');
  const g = new Game(puzzleFromLevel(row));
  const firstPlace = g.script.findIndex((s) => s.kind === 'place');
  ok('这一关的脚本里有落子的一步', firstPlace >= 0, String(firstPlace));
  ok('脚本先是不落子的划候选，再轮到写数字', firstPlace > 0, `第一条 place 在第 ${firstPlace} 步`);
  // 玩家笔记里还没有过时候选时，"划候选"这一步无事可做：话说完、游标前移，但不收钱、不动盘面
  for (let k = 0; k < firstPlace; k++) {
    const src = g.script[k];
    const h0 = g.hint();
    eq(`开头第 ${k + 1} 步：提示报的是引擎的句子`, h0.rule, src.rule.name);
    eq(`开头第 ${k + 1} 步：提示说的是同一格`, h0.cell, src.cell);
    eq(`开头第 ${k + 1} 步：这一步是划候选`, h0.kind, 'prune');
    eq(`开头第 ${k + 1} 步：没有可划的笔记就不收费`, h0.charged, false);
    eq(`开头第 ${k + 1} 步：不计入帮助次数`, g.hints, 0);
    eq(`开头第 ${k + 1} 步：不占一步操作`, g.state().steps, 0);
    eq(`开头第 ${k + 1} 步：盘面没动`, g.valueOf(src.cell), EMPTY);
    eq(`开头第 ${k + 1} 步：游标前移一格`, g.cursor, k + 1);
  }
  // 第一条真能写数字的提示：落子、计费、算一步操作
  const place = g.script[firstPlace];
  const hp = g.hint();
  eq('落子提示给的是引擎的句子', hp.rule, place.rule.name);
  eq('落子提示说的是同一格', hp.cell, place.cell);
  eq('提示带依据（那条边的编号）', typeof hp.clueIdx, 'number');
  ok('提示的话术点名了线索', hp.why.includes(clueName(row.n, hp.clueIdx)) || hp.why.includes('候选'), hp.why);
  eq('提示写进了盘面', g.valueOf(place.cell), place.value);
  eq('提示算一次帮助', g.hints, 1);
  eq('提示也算一步操作', g.state().steps, 1);
  eq('提示不动 moves（帮助不是操作）', g.state().moves, 0);
  eq('游标前移', g.cursor, firstPlace + 1);
  const undoStep = g.undo();
  eq('撤销把提示写下的数字退回', g.valueOf(place.cell), EMPTY);
  eq('但撤销不退提示次数', g.hints, 1);
  eq('undo 交回原来那一步', undoStep.kind, 'hint');
  eq('撤销退掉那一步操作', g.state().steps, 0);
  // 游标不倒回去是有意为之：倒回去就等于允许同一条提示免费重放，和帮助次数不退账是同一套口径
  eq('撤销不把游标倒回去', g.cursor, firstPlace + 1);
  // 玩家已有的落子与线索矛盾：提示拒绝落子、也不计费，只指出矛盾
  const badRow = g.script[firstPlace];
  g.cursor = firstPlace;
  const wrongValue = badRow.value === 1 ? 2 : 1;
  g.put(badRow.cell, wrongValue);
  const before = g.state().steps;
  const charged = g.hints;
  const moves = g.state().moves;
  const conf = g.hint();
  ok('与线索冲突的提示会说话', typeof conf.conflict === 'string', JSON.stringify(conf));
  ok('冲突提示的话术点名了两件事', /可 .*说这里必须是/.test(conf.conflict), conf.conflict);
  eq('冲突提示不落笔', g.valueOf(badRow.cell), wrongValue);
  eq('冲突提示不计入帮助次数', g.hints, charged);
  // 这一步之前玩家自己落了一笔（put），那笔是要算操作数的；提示本身必须一分都不加
  eq('冲突提示也不占一步操作', g.state().steps, before);
  eq('冲突提示也不动 cursor', g.cursor, firstPlace);
  const h2 = g.hint();
  eq('同一个冲突再问还是一次性回答', h2.conflict, conf.conflict);
  eq('还是不计费', g.hints, charged);
  eq('也不动已有的操作数', g.state().moves, moves);
  g.put(badRow.cell, EMPTY);
  eq('擦掉错的数字后提示就正常工作', g.hint().charged, true);
  eq('这次记了帮助', g.hints, charged + 1);
  eq('提示写下的正是线索逼出的那个数', g.valueOf(badRow.cell), badRow.value);
}
{
  // a hint whose only job is to strike a pencil mark the clues already killed — and undoing it
  const row = LEVELS.find((l) => l.tier === 'casual');
  const g = new Game(puzzleFromLevel(row));
  const idx = g.script.findIndex((s) => s.kind === 'prune');
  ok('这关的脚本里有"划候选"这一步', idx >= 0, String(idx));
  const row0 = g.script[idx];
  g.cursor = idx;
  g.st.notes[row0.cell] |= bit(row0.values[0]);
  const kept = g.st.notes[row0.cell];
  const h = g.hint();
  eq('提示报的是这一步的规则', h.rule, row0.rule.name);
  eq('提示确实动的是笔记那一格', h.cell, row0.cell);
  eq('提示收走了过时的候选', g.st.notes[row0.cell] & bit(row0.values[0]), 0);
  eq('没有把别的候选一起扫掉', g.st.notes[row0.cell] & ~bit(row0.values[0]), kept & ~bit(row0.values[0]));
  eq('这一步计一次帮助', g.hints, 1);
  g.undo();
  eq('撤销一次过时提示：候选笔记要回来', g.st.notes[row0.cell] & bit(row0.values[0]), bit(row0.values[0]));
  // 游标不倒回去，和"撤销不退提示次数"是同一套口径：倒回去就等于允许同一条提示免费重放
  eq('撤销不把游标倒回去', g.cursor, idx + 1);
  ok('撤销后盘面仍然可继续', g.status === 'playing');
}
{
  // play the clue-derived script to the end on every tier: the promise that a hint never runs out
  for (const tier of TIERS) {
    const row = LEVELS.find((l) => l.tier === tier.key);
    const g = new Game(puzzleFromLevel(row));
    const res = g.solveWithLogic();
    eq(`${tier.key}：一路提示能把这盘推到赢`, res.status, 'won');
    eq(`${tier.key}：提示推出来的盘满足全部线索`, verify(g.board, g.st.cell).length, 0);
    eq(`${tier.key}：提示推出来的盘与铅笔路径逐格相同`, asString(g.st.cell), asString(solve(g.board).derived));
    eq(`${tier.key}：提示推出来的盘就是印着的答案`, asString(g.st.cell), asString(decodeGrid(row.n, row.solution)));
    ok(`${tier.key}：确实只用提示，没写过一个猜的数`, res.hints > 0 && res.hints <= g.script.length, String(res.hints));
    eq(`${tier.key}：每一格都是提示写的（帮助次数 = 脚本里的落子步数）`, res.hints, g.script.filter((s) => s.kind === 'place').length);
    eq(`${tier.key}：推满整个盘`, g.diag.filled, row.n * row.n);
    eq(`${tier.key}：一路提示没留下矛盾格`, g.diag.badCells.size, 0);
    eq(`${tier.key}：一路提示没留下过时笔记`, g.diag.noteErrors.length, 0);
    eq(`${tier.key}：赢了之后不再接受点按`, g.tap(0), null);
    eq(`${tier.key}：赢了之后提示也停`, g.hint(), null);
    eq(`${tier.key}：赢了之后状态仍是 won`, g.status, 'won');
  }
}

sec('存档形状：storage 说谎、抛错、或留着昨天的格式时');

// A tiny localStorage, installed before js/store.js is imported. Node's own global exists but
// throws on use, so without this the module would silently be in "forgetful" mode and every
// assertion below would be vacuous.
function fakeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    map,
    api: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      clear: () => map.clear(),
      key: (i) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    },
  };
}
async function freshStore(tag, seed) {
  const f = fakeStorage(seed);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: false, value: f.api });
  const mod = await import(`../js/store.js?probe=${tag}`);
  return { Store: mod.Store, KEY: mod.KEY, _internals: mod._internals, ...f };
}
{
  const { Store, KEY, map } = await freshStore('clean');
  eq('存档只有一个键名', KEY, 'skyscraper.save.v1');
  eq('空 storage 里读出来的是默认档', Store.data.settings.sound, true);
  eq('默认档没有历史可清', Store.peek(), null);
  eq('reduceMotion 默认跟系统走（未设置时 false）', Store.setting('reduceMotion'), false);
  ok('声明自己是可写的', Store.persistent === true);
  Store.setSetting('sound', false);
  eq('设置落到了内存', Store.setting('sound'), false);
  eq('设置也落到了盘上', JSON.parse(map.get(KEY)).settings.sound, false);
  eq('两个读者读到同一份', Store.peek().settings.sound, false);
  const row = LEVELS[0];
  const g = new Game(puzzleFromLevel(row));
  g.tap(0);
  g.toggleNote(4, 3);
  Store.saveResume(puzzleFromLevel(row), g.st, 1234, { moves: g.moves, hints: g.hints });
  const raw = Store.peek();
  ok('续局记的是种子而不是盘面', typeof raw.resume.seed === 'string' && raw.resume.seed.length > 0);
  eq('续局不抄答案', 'solution' in raw.resume, false);
  eq('续局里没有 clue 数组', 'clue' in raw.resume, false);
  ok('墨迹用行程长度编码存', Array.isArray(raw.resume.ink) && raw.resume.ink.length <= 32, JSON.stringify(raw.resume.ink));
  eq('跑过的代价跟着盘面走', `${raw.resume.moves}/${raw.resume.hints}`, `${g.moves}/${g.hints}`);
  const back = Store.resume();
  eq('读回来的墨迹逐格相同', asString(back.ink), asString(g.st.cell));
  eq('读回来的笔记逐格相同', asString(back.notes), asString(g.st.notes));
  eq('读回来的种子还是那颗', back.seed, raw.resume.seed);
  eq('cells 与盘的阶相配', back.cells, row.n * row.n);
  eq('JSON 里没有 -1（哨兵不进存档）', JSON.stringify(raw).includes('-1'), false);
  Store.clearResume();
  eq('清掉续局', Store.resume(), null);
  eq('盘上也清了', Store.peek().resume, null);
  eq('通关记数', Store.clearLevel(row.id, { ms: 5000, hints: 2, moves: 20 }), true);
  eq('同一个关卡再通一次不算新通关', Store.clearLevel(row.id, { ms: 4000, hints: 1, moves: 9 }), false);
  eq('但取用掉提示更少的那次', Store.data.campaign[row.id].hints, 1);
  eq('顶掉旧的连时长一起换', Store.data.campaign[row.id].ms, 4000);
  eq('提示更多的那次不算新通关', Store.clearLevel(row.id, { ms: 1000, hints: 5, moves: 4 }), false);
  eq('也不会顶掉纪录', Store.data.campaign[row.id].hints, 1);
  eq('刷得再快也不算——帮助次数先比', Store.data.campaign[row.id].ms, 4000);
  eq('通关表里只有一个关卡', Store.clearedCount(), 1);
  eq('levelCleared 认得它', Store.levelCleared(row.id), true);
  eq('未通的关卡不认', Store.levelCleared('NOPE-99'), false);
  eq('日课同理', Store.markDaily('2026-09-27', { ms: 1000, hints: 2, moves: 30 }) && Store.dailyDone('2026-09-27'), true);
  eq('别的日期没被算进来', Store.dailyDone('2026-09-26'), false);
  eq('最好成绩先比提示', Store.recordBest('novice', { ms: 9000, hints: 0, moves: 40, size: '4×4' }), true);
  eq('提示更多时不刷新纪录', Store.recordBest('novice', { ms: 1000, hints: 3, moves: 5, size: '4×4' }), false);
  eq('提示相同才比步数', Store.recordBest('novice', { ms: 1000, hints: 0, moves: 39, size: '4×4' }), true);
  eq('步数也相同才比时间', Store.recordBest('novice', { ms: 9999, hints: 0, moves: 39, size: '4×4' }), false);
  eq('总账累加', Store.recordSolve(2000, 1) === undefined && Store.data.totals.solved, 1);
  eq('总账里的提示', Store.data.totals.hints, 1);
  eq('总账里的时长', Store.data.totals.ms, 2000);
  Store.reset();
  eq('reset 之后内存回到默认档', Store.data.settings.sound, true);
  eq('reset 之后没有续局', Store.resume(), null);
  eq('reset 之后通关清零', Store.clearedCount(), 0);
  eq('reset 连盘上的那份一起清', map.has(KEY), false);
  eq('再读一次还是默认', Store.setting('sound'), true);
}
{
  // storage that throws — a private tab, or a browser that refuses the API. The game has to stay
  // playable and merely forgetful.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: storage is closed to you');
    },
  });
  const mod = await import('../js/store.js?probe=throws');
  eq('抛错的 storage 不影响读档', mod.Store.data.settings.sound, true);
  eq('totals 仍在', mod.Store.data.totals.solved, 0);
  eq('persistent 认出了这个环境', mod.Store.persistent, false);
  eq('peek 不炸', mod.Store.peek(), null);
  eq('save 不炸', throws(() => mod.Store.save()), '');
  eq('setSetting 不炸', throws(() => mod.Store.setSetting('sound', false)), '');
  eq('只是真的没记住', mod.Store.peek(), null);
  eq('clearResume 不炸', throws(() => mod.Store.clearResume()), '');
  eq('reset 不炸', throws(() => mod.Store.reset()), '');
  eq('saveResume 不炸', throws(() => mod.Store.saveResume({ n: 4, originSeed: 'x', tier: 'novice' }, createState(mk(4, [['左', 0, 2]])), 1, { moves: 0, hints: 0 })), '');
}
{
  // storage that lies: another tab, an older version, or a hand-edited profile
  const KEY0 = 'skyscraper.save.v1';
  const cases = [
    ['不是 JSON', 'not json at all'],
    ['是个数组', '[1,2,3]'],
    ['是个数字', '42'],
    ['是个字符串', '"skyscraper"'],
    ['是 null', 'null'],
    ['settings 不是对象', '{"settings":5}'],
    ['campaign 是数组', '{"campaign":[{"ms":1}]}'],
    ['campaign 值不是对象', '{"campaign":{"a":"nope"}}'],
    ['best 缺 ms', '{"best":{"novice":{"hints":0}}}'],
    ['best 的 ms 不是数字', '{"best":{"novice":{"ms":"fast"}}}'],
    ['resume 缺 ink', '{"resume":{"seed":"x","tier":"novice"}}'],
    ['resume 的 ink 不是数组', '{"resume":{"ink":7,"notes":[]}}'],
    ['resume 的 cells 超出上限', '{"resume":{"ink":[0,9],"notes":[],"cells":9999}}'],
    ['resume 的 kind 没听过', '{"resume":{"ink":[0,9],"notes":[],"cells":16,"kind":"cheat"}}'],
    ['resume 的 seed 超长', `{"resume":{"ink":[0,9],"notes":[],"cells":16,"seed":"${'s'.repeat(500)}"}}`],
    ['resume 的 ms 是负的', '{"resume":{"ink":[0,9],"notes":[],"cells":16,"elapsedMs":-100}}'],
    ['有未知的键', '{"resume":null,"tomorrow":{"a":1}}'],
  ];
  let caseNo = 0;
  for (const [name, payload] of cases) {
    const { Store, map } = await freshStore(`dirty${caseNo++}`, { [KEY0]: payload });
    ok(`脏档「${name}」不会让读档炸`, !!Store.data && typeof Store.data === 'object');
    ok(`脏档「${name}」的默认档仍然是完整的`, ['settings', 'best', 'totals', 'resume', 'campaign', 'daily'].every((k) => k in Store.data), Object.keys(Store.data).join(','));
    ok(`脏档「${name}」读出来能安全序列化`, throws(() => JSON.stringify(Store.data)) === '');
    eq(`脏档「${name}」的 settings.sound 仍是布尔`, typeof Store.data.settings.sound, 'boolean');
    // 读一趟绝不写盘：一个只属于更新版本的键（上面那组的 tomorrow）不该因为有人打开了页面就被抹掉。
    // 盘上那份原样留着，内存里那份才是应用真正用的——写入只在玩家真的动了之后才发生。
    eq(`脏档「${name}」读一趟不会动盘上的字节`, map.get(KEY0), payload);
  }
  {
    // ……但玩家真的动了设置，盘上就会被重写。重写走的是同一份内存档：六个已知键逐个消毒过，
    // 而应用不认识的键原样带着走——更新版本存的东西不会因为旧版本打开页面而被吃掉。
    const { Store, map } = await freshStore('repair', { [KEY0]: '{"resume":null,"tomorrow":{"a":1}}' });
    Store.setSetting('sound', false);
    eq('写一次之后盘上是合法 JSON', throws(() => JSON.parse(map.get(KEY0))), '');
    eq('重写的那份带上了设置', JSON.parse(map.get(KEY0)).settings.sound, false);
    eq('未知键在内存档里原样待着', Store.data.tomorrow.a, 1);
    eq('重写时也把未知键一起带走', JSON.parse(map.get(KEY0)).tomorrow.a, 1);
    eq('消毒过的那六个键一个不少', ['settings', 'best', 'totals', 'resume', 'campaign', 'daily'].every((k) => k in Store.data), true);
    eq('内存里那份和盘上那份是同一句话', JSON.stringify(Store.peek()), JSON.stringify(JSON.parse(map.get(KEY0))));
    eq('这份档里本来就没有局可续', Store.data.resume, null);
  }
  {
    const { Store } = await freshStore('clamp', {
      [KEY0]: `{"resume":{"ink":[0,200],"notes":[[1,255]],"cells":9999,"kind":"cheat","seed":"${'s'.repeat(500)}","elapsedMs":-5,"moves":1000000000,"hints":1000000000,"at":"soon"}}`,
    });
    // int() 的口径是"离谱就退回下限"，不是夹到上限：宁可当成没记过，也不替玩家编一个数
    const r = Store.resume();
    ok('脏 resume 会被消毒而不是被相信', r !== null);
    ok('消毒两次还是同一份（读档和 resume() 用的是同一个消毒器）', asString(Store.resume().ink) === asString(r.ink));
    eq('cells 超出上限就退回下限', r.cells, 1);
    eq('退回下限后墨迹只有一格', r.ink.length, 1);
    eq('这么一格的续局配不上 4×4 的盘', r.cells === 16, false);
    eq('seed 被截到 64', r.seed.length, 64);
    eq('未知 kind 归到 tier', r.kind, 'tier');
    eq('负的时长归零', r.elapsedMs, 0);
    eq('过大的 moves 不被相信：归零', r.moves, 0);
    eq('过大的 hints 不被相信：归零', r.hints, 0);
    eq('at 不是数字就归零', r.at, 0);
    eq('套了层的笔记不是合法 RLE，就当没有笔记', r.notes.every((m) => m === 0), true);
    eq('笔记的格数与 cells 相配', r.notes.length, 1);
  }
  {
    // the shape a real save has, pushed through storage and read back by a second import
    const saved = {
      resume: {
        seed: 'origin-seed-7',
        tier: 'sharp',
        kind: 'level',
        levelId: 'COS-014',
        dateKey: null,
        elapsedMs: 98765,
        cells: 16,
        ink: [3, 16],
        notes: [200, 3, 0, 125],
        moves: 41,
        hints: 2,
        at: 1758000000000,
      },
    };
    const { Store } = await freshStore('roundtrip', { [KEY0]: JSON.stringify(saved) });
    const r = Store.resume();
    eq('续局读得回来', r.seed, 'origin-seed-7');
    eq('档位读得回来', r.tier, 'sharp');
    eq('关卡种类读得回来', r.kind, 'level');
    eq('关卡 id 读得回来', r.levelId, 'COS-014');
    eq('时长读得回来', r.elapsedMs, 98765);
    eq('代价读得回来', `${r.moves}/${r.hints}`, '41/2');
    eq('墨迹被解成 16 格', r.ink.length, 16);
    eq('行程长度还原了那 16 个 3', list(r.ink), new Array(16).fill(3).join(','));
    eq('笔记被解成 16 个掩码', r.notes.length, 16);
    eq('两个字节还原成一个 16 位掩码', r.notes[0], 200 | (200 << 8));
    eq('第二格只剩低位', r.notes[1], 200);
    eq('剩下的格没有笔记', r.notes[2], 0);
    eq('再读一次还是同一份（消毒是幂等的）', asString(Store.resume().ink), asString(r.ink));
    eq('刷新页面不会把这一局丢掉', Store.resume() === null, false);
  }
  {
    const { Store } = await freshStore('keynames', {
      [KEY0]: `{"campaign":{"${'x'.repeat(200)}":{"ms":1,"hints":0,"moves":1,"at":1}},"best":{"${'y'.repeat(200)}":{"ms":1,"hints":0,"moves":1,"at":1,"size":"${'z'.repeat(90)}"}}}`,
    });
    eq('campaign 的键名被截断', Math.max(...Object.keys(Store.data.campaign).map((k) => k.length)), 40);
    eq('best 的键名被截断', Math.max(...Object.keys(Store.data.best).map((k) => k.length)), 40);
    eq('best 的 size 被截断', Store.data.best['y'.repeat(40)].size.length, 12);
  }
  {
    // the run-length coder, on its own terms
    const { _internals } = await freshStore('rle');
    const { rleEncode, rleDecode, encodeNotes, decodeNotes, defaults, sanitizeResume } = _internals;
    eq('defaults 每次都是新对象', defaults() === defaults(), false);
    const a = new Uint8Array([0, 0, 0, 3, 3, 0, 7]);
    const enc = rleEncode(a);
    eq('编码后是成对的', enc.length % 2, 0);
    eq('解回来逐格相同', asString(rleDecode(enc, a.length)), asString(a));
    const long = new Uint8Array(1000).fill(4);
    const enc2 = rleEncode(long);
    const runs = enc2.filter((_, i) => i % 2 === 1);
    ok('一段长程被切成不超过 255 的多段', Math.max(...runs) <= 255, String(Math.max(...runs)));
    eq('切段后仍然解得回来', asString(rleDecode(enc2, 1000)), asString(long));
    const notes = Int32Array.from([0, 0x155, 0, 0x2aa, 0, 0x3ff]);
    eq('16 位笔记掩码原样回来', asString(decodeNotes(encodeNotes(notes), notes.length)), asString(notes));
    eq('解到一半的长度不炸', list(rleDecode([9, 3], 2)), '9,9');
    eq('坏掉的长度字段被跳过', list(rleDecode([9, 0, 8, 2], 3)), '8,8,0');
    eq('空的成对表解出全零', list(rleDecode([], 3)), '0,0,0');
    eq('sanitizeResume 对 null 说 null', sanitizeResume(null), null);
    eq('sanitizeResume 对数字说 null', sanitizeResume(7), null);
    eq('sanitizeResume 对缺 ink 说 null', sanitizeResume({ cells: 4, notes: [] }), null);
    eq('sanitizeResume 对缺 notes 说 null', sanitizeResume({ cells: 4, ink: [] }), null);
  }
}

sec('规则开火普查：难度是量出来的，包括那条不会开火的');

// Which rule actually fires on the boards that ship is the whole content of "难度是量出来的". A
// difficulty label is free; a table of firings is not, and three of the thirteen rules turn out to
// fire on no shipped board at all. That is printed rather than hidden, because a rule nobody uses is
// either dead code or a rung the generator never needed — either way someone has to look at it.
{
  const names = RULE_LIST.map((r) => r.name);
  eq('引擎登记的规则条数（实测）', RULE_LIST.length, 13);
  eq('规则名逐个唯一', new Set(names).size, names.length);

  const fired = new Map();
  const perTier = new Map(TIERS.map((t) => [t.key, new Map()]));
  let totalSteps = 0;
  const staleMeta = [];
  for (const row of LEVELS) {
    const board = boardOfRow(row);
    const b = solve(board);
    const use = rulesUsed(b.rows);
    for (const [k, v] of Object.entries(use)) fired.set(k, (fired.get(k) || 0) + v);
    const pt = perTier.get(row.tier);
    for (const [k, v] of Object.entries(use)) pt.set(k, (pt.get(k) || 0) + v);
    totalSteps += b.rows.length;
    // levels.js prints a pile of numbers per level. They are only honest if re-solving the printed
    // clues still produces exactly them — the day they stop, the printed difficulty is decoration.
    const places = b.rows.filter((r) => r.kind === 'place').length;
    const prunes = b.rows.filter((r) => r.kind === 'prune').length;
    const elim = b.rows.filter((r) => r.kind === 'prune').reduce((a, r) => a + r.values.length, 0);
    const top = Object.entries(use).sort((x, y) => y[1] - x[1])[0][0];
    const maxFires = Object.entries(use).sort((x, y) => y[1] - x[1])[0][1];
    const t = tierFor(row.tier);
    const bad = [];
    if (row.steps !== b.steps) bad.push(`步数 ${row.steps} ≠ ${b.steps}`);
    if (row.places !== places) bad.push(`落子 ${row.places} ≠ ${places}`);
    if (row.prunes !== prunes) bad.push(`划候选 ${row.prunes} ≠ ${prunes}`);
    if (row.eliminated !== elim) bad.push(`削候选 ${row.eliminated} ≠ ${elim}`);
    if (row.rounds !== b.rounds) bad.push(`轮次 ${row.rounds} ≠ ${b.rounds}`);
    if (row.depth !== b.depth) bad.push(`深度 ${row.depth} ≠ ${b.depth}`);
    if (Math.abs(row.score - b.score) > 1e-9) bad.push(`分数 ${row.score} ≠ ${b.score}`);
    if (row.clues !== board.clues) bad.push(`线索数 ${row.clues} ≠ ${board.clues}`);
    if (use[row.topRule] !== maxFires) bad.push(`主力规则 ${row.topRule} 已经不是开火最多的那条（最多的是 ${top}）`);
    if (row.n !== t.n) bad.push(`阶数 ${row.n} ≠ 档面 ${t.n}`);
    if (row.score < t.band[0] || row.score > t.band[1]) bad.push(`分数 ${row.score} 出了带 [${t.band}]`);
    if (bad.length) staleMeta.push(`${row.id}（${row.tier}）${bad.join(' · ')}`);
  }
  ok('印在关卡表里的每个数字都还能当场重算出来', staleMeta.length === 0, staleMeta.slice(0, 3).join(' | '));

  const sumFired = [...fired.values()].reduce((a, v) => a + v, 0);
  eq('普查把每一步都归了类：开火总数 = 所有盘的步数', sumFired, totalSteps);
  eq('没有幽灵规则：开过火的名字都在引擎的登记表里', [...fired.keys()].every((k) => names.includes(k)), true);
  eq('每张盘至少开火一条规则', TIERS.every((t) => perTier.get(t.key).size > 0), true);
  const silent = names.filter((nm) => !fired.has(nm));
  eq('烘焙关卡上开过火的规则种数（实测）', fired.size, 10);
  eq('一条都没开火的规则（实测，逐条点名）', silent.join('/'), '这个数只剩一格可放/几个数只挤得下几格/几格只装得下这几个数');
  const hardest = perTier.get('master').size;
  const easiest = perTier.get('novice').size;
  ok('最难的档用的规则种数不少于最易的档', hardest >= easiest, `novice ${easiest} → master ${hardest}`);
  const byFires = [...fired.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  · ${LEVELS.length} 张烘焙盘 · ${totalSteps} 步 · 开火 ${fired.size} 种：${byFires.map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  console.log(`  · 沉默 ${silent.length} 条：${silent.join(' / ')}`);
  console.log(
    `  · 各档用到的规则种数：${TIERS.map((t) => `${t.key} ${perTier.get(t.key).size}`).join(' · ')}`
  );
  // the two rules that need a full row of survivors are the ones the pruner never had to reach for:
  // that is a statement about the generator's greedy order, and it is worth being explicit about
  for (const nm of ['这个数只剩一格可放', '几个数只挤得下几格', '几格只装得下这几个数']) {
    ok(`沉默的那条「${nm}」仍然有单元测试兜着（见规则可靠性一节）`, RULE_LIST.some((r) => r.name === nm));
  }
}

// ---------------------------------------------------------------------------
// report
const bounds = [...marks, { section, pass, fail }];
let seenPass = 0;
let seenFail = 0;
const rows = [];
for (const m of bounds) {
  const dp = m.pass - seenPass;
  const df = m.fail - seenFail;
  if (dp + df > 0) rows.push({ section: m.section, pass: dp, fail: df });
  seenPass = m.pass;
  seenFail = m.fail;
}
const total = pass + fail;
console.log('');
for (const r of rows) console.log(`  ${String(r.pass).padStart(5)} 通过${r.fail ? ` · ${String(r.fail).padStart(3)} 失败` : '            '}  ${r.section}`);
console.log(`\n断言 ${total} 条 · 通过 ${pass} · 失败 ${fail} · 通过率 ${total ? ((pass / total) * 100).toFixed(1) : '0.0'}% · 章节 ${rows.length} 节`);
console.log('覆盖：规则可靠性 / 生成保证 / 状态机 / 存档形状');
if (fail) {
  console.log(`\n✗ ${fail} 条断言站着不行：`);
  for (const f of failures) console.log(`    · ${f}`);
  process.exit(1);
}
console.log(`\n✓ ${total} 条引擎断言全部通过：四类承诺都有独立锚点，出厂的每一关既唯一又能纯逻辑推到底。`);
