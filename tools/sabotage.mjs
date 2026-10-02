// 破坏试验台账：把每一类谎各写回树里一遍，看 `tools/doctest.mjs` 会不会**点名**变红。
//
//   node tools/sabotage.mjs          跑台账里全部刀
//   node tools/sabotage.mjs K1 K4    只跑点名的那几把（调试用；部分刀不回写 rc 列）
//
// 为什么要有这个文件：`node tools/doctest.mjs` 报的 276 条全绿只说明这一轮没有东西坏，
// 它没说这 276 条**会不会红**。本仓 README 的「文档纪律」写的就是这一条：文档是承诺，代码是事实——
// 那么"文档抄错一个数就会红"这件事本身也必须被证明过，而不是被相信着。
//
// 五条规矩（照 z-biz-game-kurotto-cos / minishop 的机制，第 4 条按本工作区的硬规矩改）：
//   1. 工作树必须干净：刀打在定稿的那一份上，否则恢复那一步会把在写的东西抹掉。
//   2. 针必须唯一命中：0 次或 >1 次都是 ERROR——"打不中却一声不响跑完"是台账最坏的失败。
//   3. rc != 0 **且**输出的 FAIL 行里出现它该杀的那条断言名才算红。语法炸了也是 rc != 0，那不是闸红。
//   4. 每把刀只恢复它那一个文件，用的是下刀前读进内存的那份字节（writeFileSync），
//      不是 git checkout / restore / reset——这个工作区是共享的，那几条命令在本仓一律禁用。
//      恢复后立刻查工作树，脏了就停，不带脏树跑下一把。
//   5. rc 一列由脚本把真实退出码读回来，不能抄；全部刀都点名变红、且整跑对照绿了才盖章。
//      盖章要能复跑：'待跑' 占位、上一次盖下的 '1'、更早的裸 1 三种写法都认，归一化成带引号后同值重盖
//      ⇒ 字节不变 ⇒ 第二次跑不会把树弄脏。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HERE = 'tools/sabotage.mjs';
const GATE = 'node tools/doctest.mjs';
const GATE_T = 420000;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const die = (msg) => { console.log(`  ERROR ${msg}`); process.exit(2); };

const sh = (cmd, timeout) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout });
  if (r.error && r.error.code === 'ETIMEDOUT') return { rc: -1, out: `${cmd}\n[超时被杀] ${r.error.message}` };
  return { rc: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const git = (a) => sh(`git ${a}`, 30000).out.trim();

// 刀谱：每把杀一组（D1 阶梯 / D5 出厂三票 / D6 引擎条数 / D8 夹具 / D9 接线与端口 / D11 反向 import）。
// expect 必须是 doctest 里那条断言**标签的原文**（FAIL 行印的就是它），不能是转述：K3 第一版写的是
// 转述「文档抄的引擎断言条数与节数逐处等于」，它在文件里确实存在（章节注释），于是预检放过了这一把，
// 可 FAIL 行里印的是标签原文，点名永远对不上——刀明明把闸打红了（D6f），台账却判它"没证明过"。
const KNIVES = [
  {
    id: 'K1', file: 'js/engine/generate.js', group: 'D1',
    why: '把 novice 的选盘带改成 [41, 63]：文档那张表的 `band` 列与 TIERS 现值不再是同一个数',
    needle: 'band: [42, 64]',
    repl: 'band: [41, 63]',
    expect: '的 band 等于 TIERS 现值',
    rc: '1',
  },
  {
    id: 'K2', file: 'js/data/levels.js', group: 'D5',
    why: '把出厂 N01 印着的 score 从 62.2 改成 62.3：生成器自己记的数与从 clue 串重算的数分家（bake 之后手写读数那一类谎）',
    needle: '"score": 62.2,',
    repl: '"score": 62.3,',
    expect: 'levels.js 印着的读数仍等于从 clue 串重算的读数',
    rc: '1',
  },
  {
    id: 'K3', file: 'README.md', group: 'D6',
    why: 'README 的复现命令注释里把引擎断言条数写成 1975：文档抄的那一份与 engine-test 自己打印的那一份差一条',
    needle: '断言 1976 · 通过 1976',
    repl: '断言 1975 · 通过 1975',
    expect: '四个数逐处等于 engine-test 现在打印的',
    rc: '1',
  },
  {
    id: 'K4', file: 'tools/verify.sh', group: 'D9',
    why: '根形态的 want 端口从 5313 改成 5314：文档写的两个端口与脚本声明的 want 不再同源（verify.sh 会 first_free 换口，所以这条只能靠引用钉）',
    needle: 'HTTP_WANT=${HTTP_PORT:-5313}',
    repl: 'HTTP_WANT=${HTTP_PORT:-5314}',
    expect: '两个端口等于脚本声明的 want',
    rc: '1',
  },
  {
    id: 'K5', file: 'js/audio/synth.js', group: 'D11',
    why: '缺席检查的反证：往运行时模块里塞一条 `js/ → tools/` 的反向 import。这一族断言平时靠「什么都没扫到」变绿，不动它一次就永远不知道它扫不扫得到',
    needle: 'let ctx = null;\nlet master = null;',
    repl: "import { bakeMain } from '../../tools/bake.mjs'; // 破坏试验用的假反向 import（K5 立刻恢复）\nlet ctx = null;\nlet master = null;",
    expect: 'js/ 永不 import tools/',
    rc: '1',
  },
  {
    id: 'K6', file: 'tools/scenarios.js', group: 'D8',
    why: '把 >>>FIXTURE 第一条 novice 的 score 从 54.4 改成 54.5：跨引擎那一钉的夹具表不再由 Node 原样重算出来（"上次 Chrome 印了什么就对什么"那一类）',
    needle: '"score":54.4',
    repl: '"score":54.5',
    expect: '全部由 Node 原样重算出来',
    rc: '1',
  },
];

const only = process.argv.slice(2);
if (only.length) {
  const known = only.filter((id) => KNIVES.some((k) => k.id === id));
  if (known.length !== only.length) die(`点名的刀有几把不在台账上：${only.filter((x) => !known.includes(x)).join(' ')}`);
}
const picked = only.length ? KNIVES.filter((k) => only.includes(k.id)) : KNIVES;

// ---- 预检：干净树 + 针唯一 + 期望点名的那条断言还在闸里 ----------------------------------------
const dirty0 = git('status --porcelain');
if (dirty0) die(`工作树不干净，刀不能打在半成品上（先 commit 或先把改动挪出本仓）：\n${dirty0}`);
const gateSrc = read('tools/doctest.mjs');
for (const k of picked) {
  let src;
  try { src = read(k.file); } catch { die(`${k.id} 的文件不存在：${k.file}`); }
  const hits = [...src.matchAll(new RegExp(k.needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].length;
  if (hits !== 1) die(`${k.id} 的针在 ${k.file} 命中 ${hits} 次（必须恰好 1 次：打不中或打多了都不许跑）`);
  if (k.repl === k.needle) die(`${k.id} 的「改成」与针相同，这一刀不会改变任何东西`);
  // 这条只是早一步的提示：连源文件里都找不到这几个字，说明那条断言被改名或删除，不必等六把刀跑完。
  // 它**不是**点名的证明——K3 第一版的 expect是一句转述，它在源文件里存在（躺在章节注释里），这里照样过，
  // 运行时那一关才把它抓住。真正的证明在下面：这一刀跑完，FAIL 行必须同时带上该组的编号和这条标签的原文。
  if (!gateSrc.includes(k.expect)) die(`${k.id} 期望点名的「${k.expect}」整份 tools/doctest.mjs 里都没有（那条断言被改名或删掉了）`);
  console.log(`  预检 ${k.id} · ${k.file} 针唯一命中 · 该杀 ${k.group}「${k.expect}」`);
}

const results = [];
for (const k of picked) {
  const before = read(k.file);
  console.log(`\n--- ${k.id}（杀 ${k.group}）${k.why}`);
  writeFileSync(join(ROOT, k.file), before.replace(k.needle, k.repl));
  const r = sh(GATE, GATE_T);
  // 只恢复这一个文件，用的是下刀之前读进内存的那份字节：本仓禁用 git checkout / restore / reset。
  writeFileSync(join(ROOT, k.file), before);
  const nowDirty = git('status --porcelain');
  // 点名要两条都对得上：断言编号属于这一把该杀的那一组，且 FAIL 行里有那条标签的原文。
  // 只比散文会让"另一条恰好含同样词"蒙过去，只比编号会让"同组里另一条"蒙过去。
  const idRe = new RegExp('FAIL\\s+' + k.group + '[a-z]?(?=\\s)');
  const failLines = r.out.split('\n').filter((l) => /^\s+FAIL\b/.test(l) && idRe.test(l) && l.includes(k.expect));
  const named = failLines.length > 0;
  const red = r.rc !== 0 && named;
  console.log(`  ${k.id} rc=${r.rc} 点名=${named ? '是' : '否'} → ${red ? '红得对' : '这一刀没能把闸打红'}`);
  if (red) {
    for (const l of failLines.slice(0, 2)) console.log(`    | ${l.trim().slice(0, 200)}`);
    console.log(`    | 闸的尾巴：${(/rows: .*$/m.exec(r.out) || ['（没有 rows 行）'])[0]}`);
  } else {
    console.log(r.out.split('\n').filter((l) => /FAIL|ERROR|error:|rows:/.test(l)).slice(0, 8).map((l) => `    | ${l}`).join('\n'));
  }
  if (nowDirty.includes(k.file)) die(`${k.id} 恢复之后 ${k.file} 还是脏的，不带脏树跑下一把`);
  results.push({ id: k.id, rc: r.rc, named, red });
}

const notRed = results.filter((x) => !x.red);
console.log('\n=== 台账 ===');
for (const x of results) console.log(`  ${x.id} rc=${x.rc} 点名=${x.named} ${x.red ? 'RED-OK' : 'NOT-RED'}`);
if (notRed.length) die(`${notRed.map((f) => f.id).join(' ')} 没能把文档闸弄红并点名：那几条断言不许算被证明过`);

// 对照：不带刀整跑一次，确认恢复之后一切照旧（也是"这一轮真绿"的最后一道证据）。
const control = sh(GATE, GATE_T);
if (control.rc !== 0) die(`全部刀恢复之后文档闸不绿（rc=${control.rc}）：\n${control.out.split('\n').filter((l) => /FAIL|rows:/.test(l)).slice(0, 12).join('\n')}`);
console.log(`  对照 doctest rc=${control.rc} · ${/rows: .*$/m.exec(control.out)?.[0] || '没有 rows 行'}`);

// 只有全部刀都点名变红、对照也绿了，才把真实退码盖回这张表。
if (picked.length !== KNIVES.length) {
  console.log('  只跑了部分刀，不回写 rc 列（整跑全部才盖章）');
} else {
  let src = read(HERE);
  for (const k of KNIVES) {
    const mine = results.find((x) => x.id === k.id);
    const row = new RegExp(`(id: '${k.id}'[\\s\\S]*?rc: )'?(\\d+|待跑)'?`);
    if (!row.test(src)) die(`回写时找不到 ${k.id} 的 rc 那一格`);
    src = src.replace(row, `$1'${mine.rc}'`);
  }
  writeFileSync(join(ROOT, HERE), src);
  console.log('  rc 列已回写进 tools/sabotage.mjs（真读回来的退码）');
}
console.log(`\nledger: PASS（${results.length} 把刀各自把 doctest 弄红并点到了名 · 组：${[...new Set(picked.map((k) => k.group))].join(' ')}）`);
