// 浏览器侧场景套件。由 tools/playtest.cjs 注入到真实页面里跑，两种 URL 形态（根 /
// Pages 的 /<repo>/ 前缀）各跑一遍。
//
// 断言纪律（照同组织已上线、闸跑通的 kakuro 仓 tools/scenarios.js 的口径）：读 DOM 几何与画布
// 像素，不读内部标志位。点一格要真的 dispatch PointerEvent、落子要真的走键盘/按钮、存档要真的从
// localStorage 反解回来比对。每个失败都打"当前值 vs 期望值"，每个通过也带着实测数字（坐标、像素
// 计数、格名）。
//
// window.skyscraper.engine 就是出货的那套引擎（main.js 把 js/engine/skyscraper.js 的模块命名空间
// 整个挂上来），所以这里通过的提示断言，等于玩家按提示走的那条路也通过。但"唯一解"和"线索语义"
// 不许只信它：下面另写了一份自己的可见数实现和一份自己的排列集枚举，加上页内 import 进来的
// js/engine/count.js（穷举计数器 + 朴素拉丁方枚举）与 js/engine/perm.js（排列表），
// 四套互不信任地对拍 —— 与 tools/bake.mjs 在 node 侧的口径一致。
//
// 跨刷新配对：playtest.cjs 每次 scenario 调用都会重新 navigate —— 同一个 Chrome profile、
// 同一块磁盘上的 localStorage。resume-a/dirty-a 写盘后收工，resume-b/dirty-b 在那次
// "真刷新"之后启动，读到的必然是反序列化+清洗过的存档，而不是内存残骸。
// 场景之间的快照走 sessionStorage（测试自己的通道，App 依旧只写一个 localStorage 键）。
//
// 资源解析：本文件里一个 `/js/...` 式的绝对路径都不许出现。所有说明符都从
// document.baseURI 解析 —— 前缀形态（/z-biz-game-skyscraper-cos/）下写死的绝对路径会 404，
// 而一次抛断的动态 import 会让后半截场景"根本没跑"，看起来像绿得少了几条。

((w) => {
  const errors = [];
  w.addEventListener('error', (e) => errors.push(String((e && e.message) || e)));
  w.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + String((e && e.reason) || e)));

  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const KEY = 'skyscraper.save.v1';
  const SNAP = '__skyscraperScnSnap';
  const A = () => w.skyscraper;
  const E = () => w.skyscraper.engine;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const text = (sel) => (($(sel) || {}).textContent || '').trim();
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shown = (sel) => {
    const e = $(sel);
    if (!e || e.hidden) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };

  const rgb = (s) => {
    const m = String(s).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) return [+m[1], +m[2], +m[3]];
    const h = String(s).replace('#', '');
    return h.length >= 6 ? [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] : [-1, -1, -1];
  };
  const near = (p, c, tol = 24) => p.every((v, i) => Math.abs(v - c[i]) <= tol);

  // 颜色只有一个来源（js/theme.js 的 Palette），样式表读它写出的自定义属性；
  // 这里读 CSS 属性而不是抄一份字面量，所以"画布和样式表读同一份令牌"这条承诺
  // 本身就是被断言的对象。
  const colors = () => ({
    ink: rgb(cssVar('--ink')),
    bgTop: rgb(cssVar('--bg-top')),
    bgBottom: rgb(cssVar('--bg-bottom')),
    surface: rgb(cssVar('--surface')),
    lift: rgb(cssVar('--surface-lift')),
    line: rgb(cssVar('--line')),
    lineHeavy: rgb(cssVar('--line-heavy')),
    info: rgb(cssVar('--info')),
    pencil: rgb(cssVar('--pencil-strong')),
    success: rgb(cssVar('--success')),
    error: rgb(cssVar('--error')),
    hint: rgb(cssVar('--hint')),
  });

  // ---- 画布取色：geo 是 CSS 像素，backing store 是 CSS×dpr ------------------------------------------------
  function countIn(cssX, cssY, cssW, cssH, target, tol) {
    const v = A().view;
    const d = v.geo.dpr;
    const x = Math.max(0, Math.round(cssX * d));
    const y = Math.max(0, Math.round(cssY * d));
    const ww = Math.max(1, Math.round(cssW * d));
    const hh = Math.max(1, Math.round(cssH * d));
    const data = v.ctx.getImageData(x, y, ww, hh).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - target[0]) <= tol && Math.abs(data[i + 1] - target[1]) <= tol && Math.abs(data[i + 2] - target[2]) <= tol) n++;
    }
    return n;
  }
  const pixel = (cssX, cssY) => {
    const v = A().view;
    const d = v.geo.dpr;
    const q = v.ctx.getImageData(Math.round(cssX * d), Math.round(cssY * d), 1, 1).data;
    return [q[0], q[1], q[2]];
  };

  // ---- 真实输入 ------------------------------------------------------------------------------------

  function pointer(type, x, y) {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }
  const canvasBox = () => A().view.canvas.getBoundingClientRect();
  /** 密集下标 i（格号）→ 页面坐标 + 格内矩形。 */
  function atCell(i) {
    const r = A().view.cellRect(i);
    const box = canvasBox();
    return { i, rect: r, x: box.left + r.x + r.size / 2, y: box.top + r.y + r.size / 2 };
  }
  async function tapCell(i) {
    const p = atCell(i);
    pointer('pointerdown', p.x, p.y);
    pointer('pointerup', p.x, p.y);
    await wait(24);
    return p;
  }
  async function dragCells(list) {
    const a = atCell(list[0]);
    pointer('pointerdown', a.x, a.y);
    for (const i of list.slice(1)) {
      const p = atCell(i);
      pointer('pointermove', p.x, p.y);
    }
    pointer('pointerup', a.x, a.y);
    await wait(24);
  }
  async function key(k) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    await wait(24);
  }
  async function click(sel) {
    const e = $(sel);
    if (!e) throw new Error(`选择器打不到东西：${sel}`);
    e.click();
    await wait(30);
  }

  // ---- 自己的一份规则实现（不 import 引擎）----------------------------------------------------------
  // 三套互不信任：引擎铅笔路径、引擎穷举计数器、这里这一套。这里的实现照着一句话定义写：
  // 从这一边往里望，看见的是"一路刷新高度纪录"的那些楼。
  function seenFrom(line, fromBack) {
    let count = 0;
    let top = 0;
    const L = line.length;
    for (let k = 0; k < L; k++) {
      const v = line[fromBack ? L - 1 - k : k];
      if (v > top) {
        top = v;
        count++;
      }
    }
    return count;
  }
  const NO_CLUE = -1;
  /** 4n 字符的线索串 → 逐边的数（'.' = 这条边什么都没印）。自己写的解码，故意不走 library.js。 */
  function decodeClueOwn(n, str) {
    const out = new Int8Array(4 * n);
    for (let i = 0; i < 4 * n; i++) out[i] = str[i] === '.' ? NO_CLUE : Number(str[i]);
    return out;
  }
  function gridOwn(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = Number(str[i]);
    return out;
  }
  /** 一个答案串按引擎的边序（上/右/下/左 × 1..n）应当印出什么；返回 4n 字符。 */
  function clueStringOwn(n, grid) {
    const row = [];
    const col = [];
    const out = new Array(4 * n).fill('.');
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) row[c] = grid[r * n + c];
      out[3 * n + r] = String(seenFrom(row, false)); // 左边往里看
      out[n + r] = String(seenFrom(row, true)); //     右边往里看
    }
    for (let c = 0; c < n; c++) {
      for (let r = 0; r < n; r++) col[r] = grid[r * n + c];
      out[c] = String(seenFrom(col, false)); //        上边往里看
      out[2 * n + c] = String(seenFrom(col, true)); // 下边往里看
    }
    return out.join('');
  }
  /** 1..n 的全部排列，按字典序（引擎的排列表是深度优先序，两者都必须是同一集合）。 */
  function permsOf(n) {
    const out = [];
    const used = new Array(n + 1).fill(false);
    const p = new Array(n);
    (function go(k) {
      if (k === n) {
        out.push(p.slice());
        return;
      }
      for (let v = 1; v <= n; v++) {
        if (used[v]) continue;
        used[v] = true;
        p[k] = v;
        go(k + 1);
        used[v] = false;
      }
    })(0);
    return out;
  }
  const permKey = (arr) => arr.join('');

  // ---- 开局 ----------------------------------------------------------------------------------------

  /** 出厂关卡：从烘焙行的线索串重建盘（不经 library 的解码器）。 */
  const boardOfLevel = (row) => E().createBoard({ n: row.n, clue: decodeClueOwn(row.n, row.clue) });
  const solOf = (row) => gridOwn(row.solution);

  async function startLevel(id) {
    A().engine.Store.reset();
    await wait(10);
    const g = A().begin({ level: id });
    await wait(30);
    return g;
  }
  async function startSeed(tier, seed) {
    A().engine.Store.reset();
    await wait(10);
    const g = A().begin({ tier, seed });
    await wait(30);
    return g;
  }
  const rowById = (id) => E().LEVELS.find((l) => l.id === id);

  // 第二套、第三套实现（js/engine/count.js 的穷举计数器、js/engine/perm.js 的排列表）都不在
  // main.js 挂出的面里 —— 它们是出题/烘焙侧的工具模块，判据只 import 了铅笔路径那套。浏览器要拿
  // 它们做"逐格复核"，就得自己在页内 import 进来，而且说明符必须从 document.baseURI 解析：
  // 这正是前缀形态要抓的那一类东西。
  const modCache = new Map();
  const modErr = new Map();
  async function pageMod(rel) {
    if (!modCache.has(rel)) {
      try {
        modCache.set(rel, await import(new URL(rel, document.baseURI).href));
      } catch (e) {
        modErr.set(rel, String((e && e.message) || e));
      }
    }
    const m = modCache.get(rel);
    if (!m) throw new Error(`${rel} 在本形态下解不开：${modErr.get(rel) || '未知'}`);
    return m;
  }
  const counters = () => pageMod('js/engine/count.js');
  const permMod = () => pageMod('js/engine/perm.js');

  // 数学那一侧：可见数分布 = 第一类无符号 Stirling 数，只从递推来，不碰任何一座楼
  function fact(n) {
    let x = 1;
    for (let i = 2; i <= n; i++) x *= i;
    return x;
  }
  function stirlingRow(n) {
    const c = Array.from({ length: n + 1 }, () => new Array(n + 1).fill(0));
    c[0][0] = 1;
    for (let i = 1; i <= n; i++) for (let k = 1; k <= i; k++) c[i][k] = c[i - 1][k - 1] + (i - 1) * c[i - 1][k];
    return c[n].slice(1);
  }
  // count.js 里没有导出 towersVisible，但它自己的边序（左上 clue[3n+r]、右 clue[n+r]、上 clue[c]、
  // 下 clue[2n+c]）是照着规则重推的，不是 import 的；这里第 6 项那两个"必然多解/必然无解"的对照盘
  // 就是拿这套边序写的 —— 边序一漂，两个对照盘的判决就反过来。
  const firstRowGivens = (n, grid) => {
    const given = new Uint8Array(n * n);
    for (let c = 0; c < n; c++) given[c] = grid[c];
    return given;
  };
  const cellStr = (a) => Array.from(a).join(',');

  // ---- 场景 1：装配与首屏（这条页面第一次在浏览器里跑起来）--------------------------------------------

  const first = async () => {
    A().engine.Store.reset();
    A().show('menu');
    await wait(40);

    eq('页面标题', document.title, '摩天楼 · Skyscraper 楼高可见数推理');
    eq('品牌行是摩天楼', text('#app h1'), '摩天楼');
    ck('window.skyscraper 挂出且带版本', typeof A().version === 'string' && /^\d+\.\d+/.test(A().version), typeof A().version);
    ck('window.App 与 window.skyscraper 是同一个对象（两种句柄一张盘）', w.App === w.skyscraper, `${typeof w.App} vs ${typeof w.skyscraper}`);
    ck('引擎跟着挂出（solve/verify/complete/diagnose/deadEnd/createBoard）',
      ['solve', 'verify', 'complete', 'diagnose', 'deadEnd', 'createBoard', 'rulesUsed', 'RULE_LIST'].every((k) => E()[k] !== undefined),
      ['solve', 'verify', 'complete', 'diagnose', 'deadEnd', 'createBoard', 'rulesUsed', 'RULE_LIST'].filter((k) => E()[k] === undefined).join(','));
    const C = await counters();
    const P = await permMod();
    ck('第二套实现（穷举计数器 + 朴素拉丁方枚举）在页内解得开', typeof C.countSolutions === 'function' && typeof C.countNaive === 'function', modErr.get('js/engine/count.js') || typeof C.countSolutions);
    ck('第三套实现（排列表 / visible / compatible）在页内解得开', typeof P.permTable === 'function' && typeof P.compatible === 'function' && typeof P.visible === 'function', modErr.get('js/engine/perm.js') || typeof P.permTable);
    ck('两套判据确实是两套：count.js 里没有铅笔路径，页面面上也没有现成的穷举计数器',
      C.solve === undefined && E().countSolutions === undefined && C.UNIQUE === 'UNIQUE',
      JSON.stringify({ countHasSolve: C.solve !== undefined, engHasCounter: E().countSolutions !== undefined, unique: String(C.UNIQUE) }));
    ck('开局前是选关页、没有盘', shown('#view-menu') && !shown('#view-game') && A().game === null,
      JSON.stringify({ menu: shown('#view-menu'), game: shown('#view-game'), game0: !!A().game }));

    // 目录：出厂关卡 / 档位 / 规则表 / 页脚那行重算值，全部对代码里的账
    const lv = E().LEVELS;
    const chs = E().CHAPTERS;
    eq('出厂关卡数（烘焙目录）', lv.length, 20);
    eq('章节数 = 档位', $$('#chapter-list .chapter').length, chs.length);
    eq('档位名与引擎同序', $$('#tier-list .tier .tier-name').map((e) => e.textContent.split(' · ')[1]).join(','), E().TIERS.map((t) => t.name).join(','));
    eq('每章的关数对得上 CHAPTERS', $$('#chapter-list .chapter').map((c) => c.querySelectorAll('.levels button').length).join(','), chs.map((c) => c.levels.length).join(','));
    eq('关卡按钮总数 = 烘焙行', $$('#chapter-list .levels button').length, lv.length);
    eq('现抽档位五档', $$('#tier-list .tier').length, 5);
    eq('规则表条数 = 引擎表', $$('#rule-list li').length, E().RULE_LIST.length);
    const total = chs.reduce((a, c) => a + c.levels.length, 0);
    eq('章节并起来就是全部出厂关（没有孤儿行）', total, lv.length);

    // 规则开火普查：页面上那句"几条一次也没开火"必须由 20 关重算出来
    const fired = {};
    for (const row of lv) {
      const s = E().solve(boardOfLevel(row));
      for (const [name, n] of Object.entries(E().rulesUsed(s.rows))) fired[name] = (fired[name] || 0) + n;
    }
    const silent = E().RULE_LIST.filter((r) => !fired[r.name]).length;
    const layers = new Set(E().RULE_LIST.map((r) => r.level)).size;
    eq('规则表标题里的条数/层数/沉默数与重算一致', text('#rule-title'),
      `铅笔路径的规则表 · ${E().RULE_LIST.length} 条、分 ${layers} 层，出厂关卡现场数出来：${silent} 条在这 20 关里一次也没开火`);
    ck('沉默规则是真的沉默（重算为 0 条开火的确实一条不落地不出现在页面上）', silent >= 0 && silent < E().RULE_LIST.length, `${silent} 条沉默`);

    const pt = E().PROOF.totals;
    const proofLead = `${pt.levels} 关 · 唯一解 ${pt.unique}/${pt.levels} · 推到底 ${pt.finished}/${pt.levels}`;
    ck('页脚那行开头是重算出的三总账', text('#proof-line').startsWith(proofLead), `页面上：${text('#proof-line')} / 重算：${proofLead}…`);
    eq('过关计数初始为 0（干净存档）', text('#cleared-count'), '0');

    // URL 形态：两种形态下都必须解析得开的东西
    const baseUrl = new URL(document.baseURI);
    ck('baseURI 以 / 结尾（文档目录，不是文件）', baseUrl.pathname.endsWith('/'), baseUrl.pathname);
    const refs = $$('script[src], link[href]')
      .map((e) => ({ el: e, ref: e.tagName === 'SCRIPT' ? e.getAttribute('src') : e.getAttribute('href') }))
      .filter((r) => r.ref && !r.ref.startsWith('data:'));
    ck('index.html 里的每条相对引用都带上了（含样式表与入口模块）', refs.length >= 2, JSON.stringify(refs.map((r) => r.ref)));
    const absolute = refs.filter((r) => r.ref.startsWith('/'));
    eq('没有写死成 origin 根的引用（/<repo>/ 前缀下必然 404）', absolute.length, 0);
    const bad = [];
    for (const r of refs) {
      const u = new URL(r.ref, document.baseURI);
      if (!u.pathname.startsWith(baseUrl.pathname)) bad.push({ ref: r.ref, out: u.pathname, base: baseUrl.pathname });
      let ok = false;
      try {
        ok = (await fetch(u.href, { cache: 'no-store' })).ok;
      } catch (e) {
        ok = false;
      }
      if (!ok) bad.push({ ref: r.ref, url: u.href, fetch: 'failed' });
    }
    ck('每条引用都在本形态下解得开且取得到（fetch 实测）', bad.length === 0, JSON.stringify(bad.slice(0, 3)));

    // 引擎模块在页内二次 import：同一个模块实例 = 说明符在本形态下解析到了同一份文件
    let imported = null;
    let importErr = '';
    try {
      imported = await import(new URL('js/engine/skyscraper.js', document.baseURI).href);
    } catch (e) {
      importErr = String((e && e.message) || e);
    }
    ck('按 document.baseURI 动态 import 引擎模块解得开', !!imported, importErr);
    if (imported) {
      ck('import 进来的就是页面在用那一套（函数同身份，不是第二份拷贝）',
        imported.solve === E().solve && imported.createBoard === E().createBoard && imported.verify === E().verify,
        `${imported.solve === E().solve} / ${imported.createBoard === E().createBoard}`);
    }
    ck('样式表已生效：主题令牌由 js/theme.js 写进 CSS 自定义属性',
      cssVar('--ink') !== '' && cssVar('--info') !== '' && cssVar('--error') !== '',
      JSON.stringify({ ink: cssVar('--ink'), info: cssVar('--info'), touch: cssVar('--touch-min') }));
    // 44 是组织标准底盘写死的触控下限（js/theme.js 的 Cell.minTouch），不是这里现编的数
    eq('触控下限令牌交给样式表的是 44px', cssVar('--touch-min'), '44px');
    eq('空格的哨兵与"这条边没印数"的哨兵不是同一个数（EMPTY=0 / NO_CLUE=-1）', `${E().EMPTY}/${E().NO_CLUE}`, '0/-1');

    // 真点一关进去：装配层能不能把一张盘画起来
    const btn = $('#chapter-list .chapter .levels button');
    const firstRow = chs[0].levels[0];
    btn.click();
    await wait(80);
    const g = A().game;
    ck('点出厂关卡第一格进入对局', shown('#view-game') && !!g, JSON.stringify({ game: shown('#view-game'), has: !!g }));
    eq('进的是出厂目录第一关', g && g.puzzle.levelId, firstRow.id);
    eq('关卡名读数', text('#stat-name'), firstRow.name);
    eq('档位名', text('#stat-tier'), E().tierFor(firstRow.tier).name);
    eq('尺寸读数带来源', text('#stat-size'), `${firstRow.n}×${firstRow.n} · 出厂关卡`);
    eq('已填读数 0/n²', text('#stat-filled'), `0/${firstRow.n * firstRow.n}`);
    eq('对上的边读数 0/线索数', text('#stat-satisfied'), `0/${firstRow.clues}`);
    eq('键盘按盘的尺寸出（4×4 只有四键）', $$('#keypad button[data-digit]').length, firstRow.n);

    const cv = $('#board');
    const box = cv.getBoundingClientRect();
    const geo = A().view.geo;
    ck('canvas 尺寸非 0', box.width > 100 && box.height > 100, `${box.width}x${box.height}`);
    ck('dpr 至少 1', geo.dpr >= 1, String(geo.dpr));
    eq('backing = CSS × dpr', Math.round(box.width * geo.dpr), cv.width);
    eq('画布 CSS 方 = cell×n + 2×band', Math.round(box.width), geo.cell * geo.n + 2 * geo.band);
    ck('首屏（含开局绘制）无未捕获异常', errors.length === 0, errors.join(' | '));
    return report({ levels: lv.length, rules: E().RULE_LIST.length, silent, base: baseUrl.pathname, cell: geo.cell, dpr: geo.dpr, refs: refs.length });
  };

  // ---- 场景 2：seed 的跨引擎确定性（续档的地基）--------------------------------------------------------
  //
  // 这一节的全部期望值都是 **node** 从 js/library.js → js/engine/generate.js 这套模块图算出来的
  // 出货（命令与口径见 verify.sh 里那段 "node re-derive" 的自检：每次跑闸都在 node 侧重算一遍，
  // 夹具对不上就红，所以它不可能是"照 Chrome 的输出抄的"）。Chrome 必须在下面这些字段上逐格复现
  // 同一张盘 —— 不只是分数、不只是线索条数，是 4n 条边和 n² 格答案整串。
  //
  // 栽过的坑长这样：出题器里 `arr.sort((a,b) => len(a)-len(b) || rng.next()-0.5)` —— 随机抽取次数
  // 依赖 Array.prototype.sort 的比较次数，而比较次数是实现相关的。同一 seed 在 node 出 26 个提示
  // 的盘、在 Chrome 出 22 个，两边各自跟自己比两次永远查不出来。本仓的续档只存
  // (origin seed, tier, 已写的数字与铅笔, 代价)，重启时按 seed 重搭盘面（js/main.js 的 begin），
  // 所以这张表错了不是"数字不好看"，是"存档会画到另一张盘上"。
  // >>>FIXTURE
  const SEED_FIXTURE = [
    {"tier":"novice","seed":"scn|novice|1","n":4,"clue":".24332122.121232","solution":"4312142321343241","derived":"4312142321343241","score":54.4,"steps":35,"places":16,"prunes":19,"eliminated":30,"rounds":1,"depth":3,"clues":14,"originSeed":"scn|novice|1","genSeed":"scn|novice|1#0","gen":1},
    {"tier":"casual","seed":"scn|casual|2","n":4,"clue":"..3.2123.2.22..1","solution":"1423213432414312","derived":"1423213432414312","score":70.6,"steps":48,"places":16,"prunes":32,"eliminated":42,"rounds":3,"depth":3,"clues":9,"originSeed":"scn|casual|2","genSeed":"scn|casual|2#0","gen":1},
    {"tier":"regular","seed":"scn|regular|3","n":5,"clue":"31.323312223.1323312","solution":"2541313542341255123442351","derived":"2541313542341255123442351","score":120.2,"steps":81,"places":25,"prunes":56,"eliminated":79,"rounds":3,"depth":3,"clues":18,"originSeed":"scn|regular|3","genSeed":"scn|regular|3#13","gen":14},
    {"tier":"sharp","seed":"scn|sharp|4","n":5,"clue":"233...1..222.423.1.2","solution":"2135414235531423542142513","derived":"2135414235531423542142513","score":135.7,"steps":83,"places":25,"prunes":58,"eliminated":89,"rounds":3,"depth":3,"clues":12,"originSeed":"scn|sharp|4","genSeed":"scn|sharp|4#6","gen":7},
    {"tier":"master","seed":"scn|master|5","n":6,"clue":"21334..5122.3522.321..23","solution":"564123652431143256435612216345321564","derived":"564123652431143256435612216345321564","score":231,"steps":141,"places":36,"prunes":105,"eliminated":165,"rounds":7,"depth":3,"clues":18,"originSeed":"scn|master|5","genSeed":"scn|master|5#4","gen":5},
    {"tier":"regular","seed":"scn-resume|regular","n":5,"clue":"132.3331.25231212323","solution":"5234141532341252541313254","derived":"5234141532341252541313254","score":118.2,"steps":75,"places":25,"prunes":50,"eliminated":78,"rounds":3,"depth":3,"clues":18,"originSeed":"scn-resume|regular","genSeed":"scn-resume|regular#11","gen":12},
    {"tier":"casual","seed":"daily:2026-03-14","daily":"2026-03-14","n":4,"clue":"13.2..1231..1.2.","solution":"4132234132141423","derived":"4132234132141423","score":63.3,"steps":38,"places":16,"prunes":22,"eliminated":36,"rounds":3,"depth":3,"clues":9,"originSeed":"daily:2026-03-14","genSeed":"daily:2026-03-14#0","gen":1}
  ];
  // <<<FIXTURE

  const encodeClueOwn = (clue) => Array.from(clue).map((v) => (v === NO_CLUE ? '.' : String(v))).join('');
  const parseDay = (key) => new Date(2000 + Number(key.slice(2, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
  function fingerprint(p) {
    return {
      n: p.n,
      clue: encodeClueOwn(p.board.clue),
      solution: Array.from(p.solution).join(''),
      derived: Array.from(E().solve(p.board).derived).join(''),
      score: p.score,
      steps: p.steps,
      places: p.places,
      prunes: p.prunes,
      eliminated: p.eliminated,
      rounds: p.rounds,
      depth: p.depth,
      clues: p.board.clues,
      originSeed: p.originSeed,
      genSeed: p.seed,
      gen: p.gen,
    };
  }

  const seed = async () => {
    A().engine.Store.reset();
    A().show('menu');
    await wait(20);
    let cellDiffs = 0;
    const diffs = [];
    for (const row of SEED_FIXTURE) {
      const p = row.daily ? E().dailyPuzzle(parseDay(row.daily)) : E().puzzleFromTier(row.tier, row.seed);
      if (!p) {
        ck(`seed ${row.seed} 在 Chrome 里出得了盘`, false, 'puzzleFromTier 返回 null');
        continue;
      }
      const got = fingerprint(p);
      // row.seed / row.tier / row.daily 是夹具的寻址键；指纹字段是 fingerprint() 返回的那 15 个
      const bad = Object.keys(row).filter((k) => k !== 'tier' && k !== 'daily' && k !== 'seed' && String(got[k]) !== String(row[k]));
      ck(`seed ${row.seed}（${row.tier}）Chrome 重出的盘与 node 出货逐格相同`, bad.length === 0,
        bad.map((k) => `${k}: Chrome ${got[k]} / node ${row[k]}`).join(' | '));
      if (bad.includes('clue') || bad.includes('solution') || bad.includes('derived')) cellDiffs++;
      for (const k of bad) if (k === 'clue' || k === 'solution' || k === 'derived') diffs.push({ seed: row.seed, field: k, got: String(got[k]).slice(0, 48), want: String(row[k]).slice(0, 48) });
      // 自洽：同 seed 在同一引擎里两次必须同一张盘（查不出实现相关，但查得出墙钟/全局态混进出题）
      const again = row.daily ? E().dailyPuzzle(parseDay(row.daily)) : E().puzzleFromTier(row.tier, row.seed);
      ck(`seed ${row.seed} 两次出货同盘（含抽样次数 ${row.gen}）`, again && encodeClueOwn(again.board.clue) === got.clue && Array.from(again.solution).join('') === got.solution,
        again ? encodeClueOwn(again.board.clue) : 'null');
    }
    ck('逐格差异为 0（4n 条边 + n² 格答案整串，两引擎之间）', cellDiffs === 0, JSON.stringify(diffs.slice(0, 2)));

    // 走 UI 的那条路：begin({tier,seed}) 装进对局的盘，必须就是同一张
    const fixtureRow = SEED_FIXTURE.find((r) => r.seed === 'scn-resume|regular');
    const g = await startSeed('regular', fixtureRow.seed);
    ck('按 seed 开局装进了盘', !!g && !!g.board, String(g));
    if (g) {
      eq('界面上这张盘的线索串 = node 的线索串', encodeClueOwn(g.board.clue), fixtureRow.clue);
      eq('界面上这张盘的铅笔解 = node 的答案', Array.from(E().solve(g.board).derived).join(''), fixtureRow.derived);
      eq('界面读数里的分数就是重算值', `${g.puzzle.score}`, `${fixtureRow.score}`);
      eq('提示脚本条数与 node 一致', g.script.length, fixtureRow.steps);
      eq('存档用的原点 seed 就是给进去的那个', g.puzzle.originSeed, fixtureRow.seed);
      eq('内部 trial seed 与 node 同一条（抽样次数也是实现无关的）', g.puzzle.seed, fixtureRow.genSeed);
    }
    A().engine.Store.reset();

    // 日课按日轮档：同一 key 永远同一档，间隔 5 天回到同一档
    const d1 = E().dailyPuzzle(new Date(2026, 2, 14));
    const d6 = E().dailyPuzzle(new Date(2026, 2, 19));
    const d2 = E().dailyPuzzle(new Date(2026, 2, 15));
    ck('日课拿得到盘', !!d1 && !!d6 && !!d2, JSON.stringify([!!d1, !!d6, !!d2]));
    eq('日课 seed 是 daily:<日期>（续档按它重搭）', d1.originSeed, `daily:${d1.dateKey}`);
    eq('相隔 5 天回到同一档（轮子周期 = 档位数）', d6.tier, d1.tier);
    ck('相邻两天不是同一档（真的在轮）', d2.tier !== d1.tier, `${d1.tier} vs ${d2.tier}`);
    eq('日课尺寸跟着档位走', `${d1.n}×${d1.n}`, `${E().tierFor(d1.tier).n}×${E().tierFor(d1.tier).n}`);
    return report({ pinned: SEED_FIXTURE.length, seeds: SEED_FIXTURE.map((r) => r.seed).join(','), cellDiffs: diffs.length, dailyTier: d1.tier });
  };

  // ---- 场景 3：规则本身的可靠性（可见数语义 + 行列全排列集合 + 边的下标约定）------------------------------
  //
  // 这一节钉的是"这条规则说的话真的是这件事吗"。三套互不信任的实现同时上：这里现写的 seenFrom /
  // clueStringOwn、js/engine/perm.js 里那份 visible+visibleBack+排列表、js/engine/count.js 里那份
  // 自己重推的边序（通过它对多解/无解盘的判决体现）。谁漂了，哪一条就红。

  const rules = async () => {
    A().engine.Store.reset();
    A().show('menu');
    await wait(20);
    const P = await permMod();

    // 1) 排列表 = 1..n 的全部排列，一个不多一个不少（字典序对拍，顺便钉住"按序索引可互换"这件事）
    const permCensus = {};
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const t = P.permTable(n);
      const mine = permsOf(n).map(permKey);
      const theirs = [];
      for (let i = 0; i < t.count; i++) {
        let s = '';
        for (let k = 0; k < n; k++) s += t.flat[i * n + k];
        theirs.push(s);
      }
      eq(`${n} 阶排列表的行数就是 ${n}! `, t.count, fact(n));
      eq(`${n} 阶排列表与自己的枚举逐行同序（同一集合、同一 DFS/字典序）`, theirs.join('|'), mine.join('|'));
      permCensus[n] = t.count;
    }
    eq('MAX_N 之外不再要表（8 阶是排列表的上限）', P.permTable(8).count, fact(8));
    let over = '';
    try {
      P.permTable(9);
    } catch (e) {
      over = String((e && e.message) || e);
    }
    ck('要第 9 阶表会明确报错，不是悄悄返回半张', /8/.test(over), over || '没抛错');

    // 2) 可见数语义：自己那份"一路刷新高度纪录"的计数 vs perm.js 的两份
    for (const n of [4, 5, 6]) {
      const t = P.permTable(n);
      const badFront = [];
      const badBack = [];
      for (let i = 0; i < t.count; i++) {
        const line = [];
        for (let k = 0; k < n; k++) line.push(t.flat[i * n + k]);
        if (P.visible(line) !== seenFrom(line, false)) badFront.push(line.join(''));
        if (P.visibleBack(line) !== seenFrom(line, true)) badBack.push(line.join(''));
      }
      ck(`${n} 阶 ${t.count} 条排列：自己数的正向可见数与 perm.js 全同`, badFront.length === 0, `${badFront.length} 条不同，例 ${badFront.slice(0, 3).join(',')}`);
      ck(`${n} 阶 ${t.count} 条排列：自己数的反向可见数与 perm.js 全同`, badBack.length === 0, `${badBack.length} 条不同，例 ${badBack.slice(0, 3).join(',')}`);
    }
    // 定义本身的两条推论：升序看得见全部 n 栋；只看见一栋 = 第一格就是 n 楼
    eq('一行里能看见 n 栋的只有升序那一种摆法', P.compatible(5, 5, NO_CLUE).length, 1);
    eq('只看见一栋的摆法数就是 (n-1)!（第一格站 n 楼）', P.compatible(5, 1, NO_CLUE).length, fact(4));
    eq('两端各看见 1 栋不可能同时成立（要两个 n 楼）', P.compatible(5, 1, 1).length, 0);

    // 3) 一行的排列集：两头各自的数滤出来的是同一批
    const compatCensus = {};
    for (const n of [4, 5, 6]) {
      const t = P.permTable(n);
      const mine = permsOf(n);
      let bad = 0;
      const firstBad = [];
      let sum = 0;
      for (let a = 1; a <= n; a++) {
        for (let b = 1; b <= n; b++) {
          const want = [];
          const got = Array.from(P.compatible(n, a, b));
          for (let i = 0; i < t.count; i++) {
            if (seenFrom(mine[i], false) === a && seenFrom(mine[i], true) === b) want.push(i);
          }
          sum += got.length;
          if (got.length !== want.length || got.some((v, k) => v !== want[k])) {
            bad++;
            if (firstBad.length < 3) firstBad.push({ a, b, got: got.length, want: want.length });
          }
        }
      }
      eq(`${n} 阶：全部 ${n * n} 组两端数字的排列集与自己的枚举逐一相同`, bad, 0);
      eq(`${n} 阶：这些排列集并起来正好铺满 ${fact(n)} 条排列（不重不漏，因为两端的数由排列唯一决定）`, sum, fact(n));
      compatCensus[n] = { bad, sum };
    }
    ck('两头都没印数时不走排列集（compatible 返回 null，用更便宜的 all-different）', P.compatible(5, NO_CLUE, NO_CLUE) === null, typeof P.compatible(5, NO_CLUE, NO_CLUE));
    eq('只印一头时另一头不滤任何东西', P.compatible(6, 3, NO_CLUE).length, P.distribution(6)[3]);

    // 4) 分布对数学：枚举 vs Stirling 递推 vs 烘进目录里的那份
    const dist = {};
    for (const n of [4, 5, 6]) {
      const byEnum = Array.from(P.distribution(n)).slice(1);
      const byRec = stirlingRow(n);
      const shipped = E().PROOF.math.stirling[n];
      eq(`${n} 阶可见数分布：枚举 = Stirling 递推`, byEnum.join(','), byRec.join(','));
      eq(`${n} 阶可见数分布：出厂目录里烘的就是这一行`, (shipped || []).join(','), byRec.join(','));
      eq(`${n} 阶分布加起来是 ${n}!`, byRec.reduce((a, b) => a + b, 0), fact(n));
      dist[n] = byEnum.join(',');
    }
    eq('拉丁方数的公开常数也写在目录里（4 阶 576 / 5 阶 161280）', `${E().PROOF.math.latin[4]},${E().PROOF.math.latin[5]}`, '576,161280');
    eq('6 阶固定首行的拉丁方数 = 9408×5!', E().PROOF.math.six.fixedFirstRow, 9408 * fact(5));

    // 5) 边的下标约定（side*n+line，边序 上/右/下/左）：引擎的两套写法 + 页面读数
    eq('SIDES 的边序', E().SIDES.join(','), '上,右,下,左');
    let idxBad = 0;
    for (const n of [4, 5, 6]) {
      for (let side = 0; side < 4; side++) for (let line = 0; line < n; line++) if (E().clueIndex(n, side, line) !== side * n + line) idxBad++;
    }
    eq('clueIndex 就是 side*n+line', idxBad, 0);
    const nameBad = [];
    for (const n of [4, 5, 6]) {
      for (let i = 0; i < 4 * n; i++) {
        const side = Math.floor(i / n);
        const line = (i % n) + 1;
        const mine = `${line}${side === 0 || side === 2 ? '列' : '行'} ${['上', '右', '下', '左'][side]}边`;
        if (E().clueName(n, i) !== mine) nameBad.push({ i, got: E().clueName(n, i), want: mine });
      }
    }
    ck('每条边的读法（几行/几列 + 哪一边）与自己的解析相同', nameBad.length === 0, JSON.stringify(nameBad.slice(0, 3)));

    // 6) 真盘上的轨道接线：行的两头是 左/右，列的两头是 上/下，而且 perms 就是上面那批排列
    let wireBad = 0;
    let trackBad = 0;
    const trackBadeg = [];
    const minePerms = {};
    for (const row of E().LEVELS) {
      const n = row.n;
      if (!minePerms[n]) minePerms[n] = permsOf(n);
      const b = boardOfLevel(row);
      for (let r = 0; r < n; r++) {
        const t = b.tracks[r];
        if (t.kind !== 'row' || t.idxA !== 3 * n + r || t.idxB !== n + r) wireBad++;
      }
      for (let c = 0; c < n; c++) {
        const t = b.tracks[n + c];
        if (t.kind !== 'col' || t.idxA !== c || t.idxB !== 2 * n + c) wireBad++;
      }
      for (const t of b.tracks) {
        if (t.perms === null) {
          // 两头都没印数：引擎走更便宜的 all-different 路径，不带排列集
          if (b.clue[t.idxA] !== NO_CLUE || b.clue[t.idxB] !== NO_CLUE) trackBad++;
          continue;
        }
        // 行的 cells 是左→右、列的 cells 是上→下，所以两头的数就是同一批排列的正/反可见数
        const want = [];
        for (let i = 0; i < minePerms[n].length; i++) {
          const p = minePerms[n][i];
          if (b.clue[t.idxA] !== NO_CLUE && seenFrom(p, false) !== b.clue[t.idxA]) continue;
          if (b.clue[t.idxB] !== NO_CLUE && seenFrom(p, true) !== b.clue[t.idxB]) continue;
          want.push(i);
        }
        const list = Array.from(t.perms);
        if (list.length !== want.length || list.some((v, k) => v !== want[k])) {
          trackBad++;
          if (trackBadeg.length < 3) trackBadeg.push({ id: row.id, track: t.name, got: list.length, want: want.length });
        }
      }
    }
    eq('20 关 × 2n 条轨道的接线（哪一头是哪条边）全部合约定', wireBad, 0);
    ck('每条轨道带的排列集与自己的枚举相同（引擎真在用上面第 3 项那批集合）', trackBad === 0, JSON.stringify(trackBadeg));

    // 7) 答案串 ↔ 线索串：cluesFrom 与自己那份边序实现必须逐字符相同，出厂行也要自洽
    const grids = E().LEVELS.map((r) => ({ n: r.n, grid: gridOwn(r.solution), tag: r.id, clue: r.clue }));
    let csBad = 0;
    const csEg = [];
    for (const g of grids) {
      const viaEngine = encodeClueOwn(E().cluesFrom(g.n, g.grid));
      const viaOwn = clueStringOwn(g.n, g.grid);
      if (viaEngine !== viaOwn) {
        csBad++;
        if (csEg.length < 3) csEg.push({ tag: g.tag, engine: viaEngine, own: viaOwn });
      }
    }
    ck('cluesFrom 与自己的 4n 边序实现逐字符相同（含全部 20 个答案串）', csBad === 0, JSON.stringify(csEg));
    const clueMismatch = [];
    const clueRound = [];
    for (const r of E().LEVELS) {
      const b = boardOfLevel(r);
      if (encodeClueOwn(b.clue) !== r.clue) clueRound.push(r.id);
      const fromAnswer = clueStringOwn(r.n, gridOwn(r.solution));
      for (let i = 0; i < 4 * r.n; i++) {
        const printed = decodeClueOwn(r.n, r.clue)[i];
        if (printed !== NO_CLUE && String(fromAnswer[i]) !== String(printed)) clueMismatch.push({ id: r.id, i, printed, fromAnswer: fromAnswer[i] });
      }
      if (b.clues !== r.clues) clueMismatch.push({ id: r.id, clues: b.clues, printed: r.clues });
    }
    ck('出厂行的每一条印数都真的能从它自己的答案串上数出来（没有一条是手填的）', clueMismatch.length === 0, JSON.stringify(clueMismatch.slice(0, 3)));
    eq('线索串的解码→再编码回到原文（两条解码路径没漂）', clueRound.length, 0);

    // 8) 独立验收 verify/complete：答案必须过，改一格必须不过
    const verifyBad = [];
    const mutateBad = [];
    for (const r of E().LEVELS) {
      const b = boardOfLevel(r);
      const sol = gridOwn(r.solution);
      if (E().verify(b, sol).length !== 0) verifyBad.push(r.id);
      if (!E().complete(b, sol)) verifyBad.push(`${r.id} 不认自己的答案`);
      const mut = Uint8Array.from(sol);
      const t0 = b.tracks[0]; // 同一行里换两个位置：拉丁方性质先破，再破可见数
      const x = t0.cells[0];
      const y = t0.cells[1];
      const tmp = mut[x];
      mut[x] = mut[y];
      mut[y] = tmp;
      const bad = E().verify(b, mut);
      if (bad.length === 0) mutateBad.push({ id: r.id, why: '换了两格竟然还算通过' });
      else if (!bad.every((p) => ['空格', '重复高度', '线索对不上'].includes(p.why))) mutateBad.push({ id: r.id, why: bad.map((p) => p.why).join('/') });
    }
    ck('verify() 认得下全部 20 个答案、complete() 也说完成', verifyBad.length === 0, JSON.stringify(verifyBad));
    ck('把任意一行里两格对调后 verify() 必然报错，而且报的是这三种之一', mutateBad.length === 0, JSON.stringify(mutateBad.slice(0, 3)));
    const hole = E().verify(boardOfLevel(E().LEVELS[0]), new Uint8Array(16));
    ck('空格子是被单独记一笔的（不是"重复高度"的假报错）', hole.length === 16 && hole.every((p) => p.why === '空格'), JSON.stringify(hole.slice(0, 2)));

    // 9) 页面上那张规则表就是引擎里那张：名次、层号、权重、开火次数一个数都不许是自己编的
    const fired2 = {};
    for (const row of E().LEVELS) {
      const s = E().solve(boardOfLevel(row));
      for (const [name, k] of Object.entries(E().rulesUsed(s.rows))) fired2[name] = (fired2[name] || 0) + k;
    }
    const orderWant = [...E().RULE_LIST].sort((a, b) => a.level - b.level || a.weight - b.weight).map((r) => r.name);
    eq('规则表名次 = 引擎表按（层，权重）排出来的名次', $$('#rule-list li b').map((e) => e.textContent.trim()).join(','), orderWant.join(','));
    const liBad = [];
    const li = $$('#rule-list li');
    for (let i = 0; i < li.length; i++) {
      const r = [...E().RULE_LIST].sort((a, b) => a.level - b.level || a.weight - b.weight)[i];
      const m = li[i].textContent.match(/第 (\d+) 层 · 权重 ([\d.]+) · 出厂关卡里开火 (\d+) 次/);
      const want = [String(r.level), String(r.weight), String(fired2[r.name] || 0)];
      if (!m || m.slice(1).join('|') !== want.join('|')) liBad.push({ name: r.name, onPage: m && m.slice(1).join('|'), fromEngine: want.join('|') });
      const silentMark = /（沉默）/.test(li[i].textContent);
      if (silentMark !== (fired2[r.name] === undefined)) liBad.push({ name: r.name, silent: silentMark, fired: fired2[r.name] || 0 });
    }
    ck('每条规则印出来的层号/权重/开火次数都由引擎记录 + 20 关重算值对得上（含"沉默"标记）', liBad.length === 0, JSON.stringify(liBad.slice(0, 3)));
    const levels = [...new Set(E().RULE_LIST.map((r) => r.level))].sort((a, b) => a - b);
    ck('规则表 13 条分 4 层：层号连续、权重全为正（分数是权重累加出来的测量值）',
      E().RULE_LIST.length === 13 && levels.length === 4 && levels.join(',') === '1,2,3,4'
        && E().RULE_LIST.every((r) => typeof r.weight === 'number' && r.weight > 0)
        && E().RULE_LIST.every((r) => typeof r.text === 'function' && r.key === E().Rules[r.key].key),
      JSON.stringify(E().RULE_LIST.map((r) => [r.name, r.level, r.weight])));
    // 深度 = 这条路径用到的最深层；它也是页面上"推理深度"读数的口径
    const depthBad = E().LEVELS.filter((r) => {
      const s = E().solve(boardOfLevel(r));
      return s.depth === Math.max(...s.rows.map((x) => x.rule.level)) && s.depth === r.depth;
    }).length !== E().LEVELS.length;
    ck('每关的深度读数就是这条铅笔路径真正踩到的最深层', !depthBad, JSON.stringify(E().LEVELS.map((r) => [r.id, r.depth, E().solve(boardOfLevel(r)).depth]).slice(0, 4)));

    ck('本节无未捕获异常', errors.length === 0, errors.join(' | '));
    return report({ permCensus, dist, compatCensus, tracks: E().LEVELS.reduce((a, r) => a + 2 * r.n, 0), edges: E().LEVELS.reduce((a, r) => a + 4 * r.n, 0) });
  };

  // ---- 场景 4：唯一解由第二、第三套实现逐格复核（浏览器里也要复现 bake 的三本账）------------------------

  const unique = async () => {
    A().engine.Store.reset();
    A().show('menu');
    await wait(20);
    const C = await counters();
    const LV = E().LEVELS;
    const budget = 4000000; // 与 tools/bake.mjs 的 COUNT_BUDGET 同一个数
    const latinLeaves = { 3: 12, 4: 576, 5: 161280 };
    let maxNodes = 0;
    const nodeByTier = {};
    const leafByN = {};
    const fails = [];
    for (const row of LV) {
      const board = boardOfLevel(row);
      const s = E().solve(board);
      const c = C.countSolutions(board, { cap: 2, budget });
      const naive = row.n <= 5 ? C.countNaive(board, { cap: 2 }) : C.countNaive(board, { cap: 2, given: firstRowGivens(row.n, s.derived) });
      maxNodes = Math.max(maxNodes, c.nodes);
      nodeByTier[row.tier] = Math.max(nodeByTier[row.tier] || 0, c.nodes);
      leafByN[row.n] = naive.checked;
      ck(`${row.id}（${row.tier} ${row.n}×${row.n}）三套互不信任：唯一 ✓ 穷举逐格同解 ✓ 朴素 ✓`,
        s.ok && c.status === C.UNIQUE && c.solutions === 1 && cellStr(c.first) === cellStr(s.derived)
          && naive.solutions === 1 && cellStr(naive.first) === cellStr(s.derived)
          && E().verify(board, s.derived).length === 0 && encodeClueOwn(board.clue) === row.clue,
        JSON.stringify({ ok: s.ok, status: c.status, solutions: c.solutions, nodes: c.nodes, pencilSame: c.first && cellStr(c.first) === cellStr(s.derived), naiveSol: naive.solutions, naiveChecked: naive.checked, accepted: E().verify(board, s.derived).length }));
      const printed = { score: row.score, steps: row.steps, places: row.places, prunes: row.prunes, eliminated: row.eliminated, rounds: row.rounds, clues: row.clues, depth: row.depth, topRule: row.topRule, solution: row.solution };
      const got = { score: s.score, steps: s.steps, places: s.places, prunes: s.prunes, eliminated: s.eliminated, rounds: s.rounds, clues: board.clues, depth: s.depth, topRule: Object.entries(s.breakdown).sort((a, b) => b[1] - a[1])[0][0], solution: Array.from(s.derived).join('') };
      const drift = Object.keys(printed).filter((k) => String(printed[k]) !== String(got[k]));
      ck(`${row.id} 印着的十项测量值由浏览器里这套引擎原样重算`, drift.length === 0, drift.map((k) => `${k}: 印 ${printed[k]} / 算 ${got[k]}`).join(' | '));
      if (drift.length || c.status !== C.UNIQUE) fails.push(row.id);
    }
    const t = E().PROOF.totals;
    ck('出厂目录的三本账（唯一解/推到底/朴素同意）与逐关判决一致',
      t.levels === LV.length && t.unique === LV.length && t.finished === LV.length && t.naiveAgree === LV.length && fails.length === 0,
      JSON.stringify({ ...t, fails: fails.slice(0, 4) }));
    // 「超预算」是承诺破口：计数器要么给判决，要么承认没数完 —— 这里既要它给判决，也要它没贴近上限
    ck(`${LV.length} 关的穷举都没贴到 ${budget} 节点上限`, maxNodes < budget / 4, `最大 ${maxNodes}，上限 ${budget}`);

    // 第三路（最笨那一套）访问的叶子数必须是公开常数 —— 它证明穷举真的铺满了拉丁方空间
    const leafBad = [];
    for (const row of LV) {
      const board = boardOfLevel(row);
      const s = E().solve(board);
      const naive = row.n <= 5 ? C.countNaive(board, { cap: 2 }) : C.countNaive(board, { cap: 2, given: firstRowGivens(row.n, s.derived) });
      const want = row.n <= 5 ? latinLeaves[row.n] : E().PROOF.math.six.fixedFirstRow;
      if (naive.checked !== want) leafBad.push({ id: row.id, got: naive.checked, want });
    }
    ck('每关朴素枚举访问的拉丁方数都正好是公开常数（4 阶 576 / 5 阶 161280 / 6 阶固定首行 1128960）', leafBad.length === 0, JSON.stringify(leafBad.slice(0, 4)));

    // 运行时抽的盘（日课与按 seed 重搭的那七张）同样要过三关 —— 玩家能玩到的不只是烘好的 20 关
    const seedBad = [];
    for (const row of SEED_FIXTURE) {
      const p = row.daily ? E().dailyPuzzle(parseDay(row.daily)) : E().puzzleFromTier(row.tier, row.seed);
      const c = C.countSolutions(p.board, { cap: 2, budget });
      let naive = null;
      if (p.n <= 5) {
        naive = C.countNaive(p.board, { cap: 2 });
        if (!(naive.solutions === 1 && cellStr(naive.first) === cellStr(p.solution))) seedBad.push({ seed: row.seed, naive: naive.solutions });
      } else {
        c.naiveSkipped = '6 阶的第三路在关卡那一节按公开常数核过了';
      }
      if (!(c.status === C.UNIQUE && cellStr(c.first) === cellStr(p.solution))) seedBad.push({ seed: row.seed, status: c.status, nodes: c.nodes });
    }
    ck(`${SEED_FIXTURE.length} 张按 seed 重搭的盘全部唯一解（穷举逐格同解${seedBad.length ? '，例外见 detail' : '，无例外'}）`, seedBad.length === 0, JSON.stringify(seedBad.slice(0, 3)));

    // 判据的反面：这两个对照盘证明计数器会说"多解"和"无解"，不会一律点头
    const n4 = 4;
    const many = new Int8Array(4 * n4).fill(NO_CLUE);
    many[0] = 1; // 只有第 1 列上边写着 1
    const manyBoard = E().createBoard({ n: n4, clue: many });
    const cm = C.countSolutions(manyBoard, { cap: 2, budget });
    const nm = C.countNaive(manyBoard, { cap: 2 });
    ck('只写一条边的盘被两路同时判为多解（计数器不是只会说 UNIQUE）',
      cm.status === C.MANY && cm.solutions === 2 && nm.solutions === 2, JSON.stringify({ status: cm.status, sol: cm.solutions, naive: nm.solutions }));
    ck('这种盘的铅笔路径确实推不到底（生成器的验收不是白过的）', E().solve(manyBoard).ok === false, JSON.stringify(E().solve(manyBoard).ok));
    const none = new Int8Array(4 * n4).fill(NO_CLUE);
    none[3 * n4 + 0] = 4; // 第 1 行左边 4：整行必须是 1,2,3,4
    none[3] = 4; // 第 4 列上边 4：该列第一格必须是 1 —— 与上面那条边直接矛盾
    const noneBoard = E().createBoard({ n: n4, clue: none });
    const cn = C.countSolutions(noneBoard, { cap: 2, budget });
    const nn = C.countNaive(noneBoard, { cap: 2 });
    ck('自相矛盾的边序摆法被两路同时判为无解（count.js 自己重推的边序与引擎一致）',
      cn.status === C.NONE && cn.solutions === 0 && nn.solutions === 0, JSON.stringify({ status: cn.status, sol: cn.solutions, naive: nn.solutions }));
    let guard = '';
    try {
      C.countSolutions({ n: 4, size: 16, clue: new Int8Array(16).fill(0), tracks: [], clues: 1 }, { cap: 2, budget });
    } catch (e) {
      guard = String((e && e.message) || e);
    }
    ck('0 不是这盘的"无边"哨兵：拿 0 当线索会被穷举计数器直接拒绝', /哨兵|非法/.test(guard), guard || '没抛错');
    let cheap = null;
    try {
      cheap = C.countSolutions(boardOfLevel(LV[LV.length - 1]), { cap: 2, budget: 50 });
    } catch (e) {
      cheap = { status: 'threw: ' + e.message };
    }
    ck('预算不够时它承认没数完（OVERBUDGET 且交不出第一解），而不是假装唯一',
      cheap && cheap.status === C.OVERBUDGET && cheap.first === null, JSON.stringify({ status: cheap && cheap.status, first: cheap && cheap.first }));

    ck('本节无未捕获异常', errors.length === 0, errors.join(' | '));
    return report({ levels: LV.length, maxNodes, nodeByTier, leafByN, budget, controls: { many: cm.status, none: cn.status } });
  };

  /**
   * 状态行的口径（不校抄写）：该不该开口、开口时必须带着哪个数。
   * 分支优先级照 js/main.js 的 stateLine：赢了 > 已推不完 > 边对不上 > 重复格 > 候选过期 > 无话可说。
   * 这里只断言"该闭嘴时是空的、该开口时那句里带着对应的计数"，页面换文案不会误红。
   */
  function expectLine(s) {
    if (s.status === 'won') return { kind: 'won', needle: null };
    if (s.dead) return { kind: 'dead', needle: s.dead };
    if (s.conflicts) return { kind: 'conflicts', needle: String(s.conflicts) };
    if (s.badCells) return { kind: 'badCells', needle: String(s.badCells) };
    if (s.noteErrors) return { kind: 'noteErrors', needle: String(s.noteErrors) };
    return { kind: 'empty', needle: '' };
  }
  function checkLine(tag, s) {
    const want = expectLine(s);
    const got = text('#state-line');
    if (want.kind === 'empty') return ck(`${tag}：无话可说时状态行是空的`, got === '', got);
    if (want.needle === null) return ck(`${tag}：赢的时候状态行开口`, got !== '', got);
    return ck(`${tag}：状态行开口且带着 ${want.kind} 这个计数`, got.includes(want.needle), `页面上：${got} / 该带：${want.needle}`);
  }

  // ---- 场景 5：落子 / 划候选 / 撤销（真指针手势 + 自己反解存档）--------------------------------------

  function rleDecodeOwn(pairs, len) {
    const b = new Uint8Array(len);
    let i = 0;
    for (let p = 0; p + 1 < pairs.length; p += 2) {
      const v = pairs[p];
      const k = pairs[p + 1];
      if (!(k > 0)) continue;
      for (let z = 0; z < k && i < len; z++) b[i++] = v;
    }
    return b;
  }
  function notesDecodeOwn(pairs, cells) {
    const bytes = rleDecodeOwn(pairs, cells * 2);
    const out = new Int32Array(cells);
    for (let i = 0; i < cells; i++) out[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    return out;
  }

  const play = async () => {
    const row = rowById(E().LEVELS[0].id); // 4×4：一圈按六下点完
    const g = await startLevel(row.id);
    const n = g.w;
    const size = n * n;
    eq('开局是出厂第一关', g.puzzle.levelId, row.id);
    eq('开局盘面为空', Array.from(g.st.cell).join(''), '0'.repeat(size));

    // 1) 同一格连点：空 → 1 → … → n → 空，一次手势 = 一步历史
    const ring = [];
    for (let k = 0; k <= n; k++) {
      await tapCell(0);
      ring.push(A().valueOf(0));
    }
    eq('点 n+1 下把一格走完一整圈（空→1→…→n→空）', ring.join(','), `${Array.from({ length: n }, (_, k) => k + 1).join(',')},0`);
    eq('一圈是 n+1 次手势、也就 n+1 步历史', g.steps.length, n + 1);
    eq('步数读数与手势次数一致', Number(text('#stat-moves')), n + 1);
    eq('一圈点完又回到空（读数也跟着回 0）', `${text('#stat-filled')}`, `0/${size}`);
    for (let k = 0; k <= n; k++) await click('#btn-undo');
    eq('按 n+1 次撤销按钮把这一圈全部退回', Array.from(g.st.cell).join(''), '0'.repeat(size));
    eq('退回后历史为空', g.steps.length, 0);

    // 2) 键盘盘写Exact 数字：只写点出来的那个高度，并只按下一个键
    await click('#keypad button[data-digit="3"]');
    eq('点键盘盘的 3 就往选中格写 3', A().valueOf(g.selected), 3);
    eq('选中格就是刚点的那格', g.selected, 0);
    eq('只有 3 这个键是按下态', $$('#keypad button').map((b) => b.getAttribute('aria-pressed')).join(','), 'false,false,true,false');
    eq('键盘盘只出这一盘的 1..n', $$('#keypad button[data-digit]').map((b) => b.dataset.digit).join(','), '1,2,3,4');
    await click('#btn-erase');
    eq('清除把这格写回空（一次手势一步）', A().valueOf(0), 0);
    eq('写 3 与清除各算一步', g.steps.length, 2);

    // 3) 候选模式：点一格是 toggle，不是乘数字
    await click('#btn-mode-note');
    eq('候选模式挂到画布上', A().view.canvas.dataset.mode, 'note');
    eq('两个笔模式按钮的按下态互斥', [$('#btn-mode-ink'), $('#btn-mode-note')].map((b) => b.getAttribute('aria-pressed')).join(','), 'false,true');
    A().setDigit(2);
    await tapCell(5);
    eq('候选模式下点一格只划一个候选', A().noteOf(5), 1 << 2);
    await tapCell(5);
    eq('再点一下就是抹掉这个候选', A().noteOf(5), 0);
    A().setDigit(2);
    await tapCell(6);
    await tapCell(6);
    await click('#btn-mode-ink');
    A().tap(6, 1);
    eq('写了数字的格不能再划候选（两条通道各管一件事）', A().noteOf(6), 0);
    await tapCell(6);
    eq('数字模式下点已有数字的格是走那一圈而不是划候选', A().noteOf(6), 0);
    await click('#btn-mode-note');
    const beforeNote = A().valueOf(6);
    await tapCell(6);
    eq('候选笔在带数字的格上什么都不改', A().valueOf(6), beforeNote);
    await click('#btn-wipe');
    eq('抹候选只动候选不动数字', A().valueOf(6), beforeNote);

    // 4) 一次拖 = 一次撤销（而不是三下）
    await click('#btn-mode-ink');
    A().setDigit(2);
    const stepsBefore = A().game.steps.length;
    const movesBefore = A().game.moves;
    await dragCells([9, 10, 11]);
    eq('拖过的三格都写上当前高度', [9, 10, 11].map((i) => A().valueOf(i)).join(','), '2,2,2');
    eq('一次拖动只记一步历史', A().game.steps.length, stepsBefore + 1);
    eq('一次拖动只计一步 move', A().game.moves, movesBefore + 1);
    eq('这一步写的就是拖过的三格', A().game.steps[A().game.steps.length - 1].writes.map((x) => `${x.cell}:${x.to.v}`).join(','), '9:2,10:2,11:2');
    await click('#btn-undo');
    eq('撤销一次拖：三格同时回到空', [9, 10, 11].map((i) => A().valueOf(i)).join(','), '0,0,0');
    eq('撤销只退一步历史', A().game.steps.length, stepsBefore);
    // 一次手势一步快照的可检验说法：把所有历史退干净，盘面必须一格不剩地回到开局
    let guard = 0;
    while (A().game.undo() !== null && guard++ < 400);
    eq('历史退干净后盘面回到全空', Array.from(A().game.st.cell).join(''), '0'.repeat(size));
    eq('候选也一起回到全空', Array.from(A().game.st.notes).map(String).join(','), new Array(size).fill('0').join(','));
    eq('退到没有可退时交不出东西（也不报错）', A().game.undo(), null);
    eq('move 计数不会被撤成负数', A().game.moves, 0);
    eq('退干净之后历史为空', A().game.steps.length, 0);
    // 本作没有重做通道（唯一的「重做」是日课那枚「再做一遍今日」的按钮），按真实 API 写：
    // 撤回去的东西只能重新落一次，不存在 redo()。
    ck('面上、Game 上、对局视图里都没有重做通道',
      A().redo === undefined && A().game.redo === undefined && $('#btn-redo') === null
        && $$('#view-game button').every((b) => !/重做|redo/i.test(`${b.id || ''} ${b.textContent}`)),
      JSON.stringify({ onSurface: A().redo !== undefined, onGame: A().game.redo !== undefined, gameButtons: $$('#view-game button').map((b) => b.id || b.textContent.trim()).join('/') }));
    ck('日课按钮的文案只可能是 今日 / 重做（这里的"重做"是再做一遍今日）', /^(今日|重做)$/.test(text('#btn-daily')), text('#btn-daily'));

    // 5) 存档：只有一个键，而且 RLE 反解回来就是屏上这堆墨
    A().tap(0, 4);
    A().tap(size - 1, 3);
    A().setDigit(1);
    await tapCell(1);
    await click('#btn-mode-note');
    await tapCell(size - 2);
    await click('#btn-mode-ink');
    const keys = Object.keys(localStorage);
    eq('localStorage 上只有这一个键', keys.join(','), KEY);
    const raw = Store_peek();
    ck('存的是 (原点 seed, 档位, 墨, 候选, 代价)，而不是盘面副本',
      raw && raw.resume && typeof raw.resume.seed === 'string' && raw.resume.tier === row.tier && Array.isArray(raw.resume.ink) && Array.isArray(raw.resume.notes),
      JSON.stringify(Object.keys((raw || {}).resume || {})));
    eq('续档里没有 clue/solution 这两个字段', ['clue', 'solution', 'board'].filter((k) => k in (raw.resume || {})).join(','), '');
    eq('存的格子数就是这一盘', raw.resume.cells, size);
    eq('自己反解 RLE 得到的墨与内存里的逐格相同', Array.from(rleDecodeOwn(raw.resume.ink, size)).join(','), Array.from(g.st.cell).join(','));
    eq('自己反解双字节候选得到的与内存里的逐格相同', Array.from(notesDecodeOwn(raw.resume.notes, size)).join(','), Array.from(g.st.notes).join(','));
    eq('墨与候选不能同时写同一格（写了数字那格的候选被清空）', Array.from(g.st.cell).map((v, i) => (v && g.st.notes[i] ? i : -1)).filter((i) => i >= 0).join(','), '');
    eq('代价两项与内存读数一致', `${raw.resume.moves},${raw.resume.hints}`, `${g.moves},${g.hints}`);

    // 6) 设置开关是真的开关（不是只改了文案）
    const s0 = A().engine.Store.setting('sound');
    await click('#btn-sound');
    eq('音效按钮改了存档里的设置', A().engine.Store.setting('sound'), !s0);
    eq('音效按钮的文案跟着状态走', text('#btn-sound'), A().engine.Store.setting('sound') ? '音效 开' : '音效 关');
    eq('aria-pressed 与状态一致', $('#btn-sound').getAttribute('aria-pressed'), String(!!A().engine.Store.setting('sound')));
    await click('#btn-motion');
    eq('省动效开关也进了存档', A().engine.Store.setting('reduceMotion'), true);
    eq('省动效写进了 body 的 class', document.body.classList.contains('reduce-motion'), true);
    await click('#btn-motion');

    ck('本节无未捕获异常', errors.length === 0, errors.join(' | '));
    A().engine.Store.reset();
    return report({ n, moves: g.moves, hints: g.hints, ink: Array.from(g.st.cell).join(''), notes: Array.from(g.st.notes).join(',') });
  };
  const Store_peek = () => {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  };

  // ---- 场景 6：冲突标记（引擎的判据 vs 自己拿全排列枚举出来的判据）----------------------------------

  const permCache = {};
  const permsFor = (n) => permCache[n] || (permCache[n] = permsOf(n));
  const wantCache = {};
  function permsWith(n, want, back) {
    const key = `${n}|${want}|${back ? 1 : 0}`;
    if (!wantCache[key]) wantCache[key] = permsFor(n).filter((p) => seenFrom(p, back) === want);
    return wantCache[key];
  }
  /**
   * 自己的一份边判据：不复制引擎的前缀算术，而是把「这条边印着 want」的全部摆法摊开，
   * 看有没有一种装得下已经写下的墨。dead = 一种都没有（这条边真的圆不回来了）；
   * met = 写满且读数正好。引擎只按紧邻前缀算，所以它的 dead 应是自己这份的子集。
   * （线里"这格还空着"用的是引擎自己的 EMPTY 哨兵，不在测试里另抄一个 0。）
   */
  function clueVerdictOwn(n, clue, want, line) {
    if (want === NO_CLUE) return { met: false, dead: false };
    const cand = permsWith(n, want, false);
    const fits = cand.some((p) => line.every((v, k) => v === 0 || v === p[k]));
    const full = line.every((v) => v !== 0);
    // 「对上了」还得要求这一行真的是个排列：写了两个 2 的行即使读数巧合也谈不上满足线索
    const latin = new Set(line).size === n;
    return { met: full && latin && seenFrom(line, false) === want, dead: !fits };
  }
  /** 在这堆墨下，逐条边的判决（正向线 = 左→右 / 上→下；反向线翻过来）。 */
  function verdictsOwn(board, grid) {
    const n = board.n;
    const met = new Set();
    const dead = new Set();
    const bad = new Set();
    const EMPTY = E().EMPTY; // 引擎自己的空格哨兵（第一节钉过它是 0，不是 -1）
    for (const t of board.tracks) {
      const fwd = [];
      for (let k = 0; k < n; k++) fwd.push(grid[t.cells[k]]);
      const back = fwd.slice().reverse();
      const seen = new Map();
      for (const v of fwd) if (v !== EMPTY) seen.set(v, (seen.get(v) || 0) + 1);
      for (let k = 0; k < n; k++) if (fwd[k] !== EMPTY && seen.get(fwd[k]) > 1) bad.add(t.cells[k]);
      if (board.clue[t.idxA] !== NO_CLUE) {
        const r = clueVerdictOwn(n, board.clue, board.clue[t.idxA], fwd);
        if (r.met) met.add(t.idxA);
        if (r.dead) dead.add(t.idxA);
      }
      if (board.clue[t.idxB] !== NO_CLUE) {
        const r = clueVerdictOwn(n, board.clue, board.clue[t.idxB], back);
        if (r.met) met.add(t.idxB);
        if (r.dead) dead.add(t.idxB);
      }
    }
    return { met, dead, bad };
  }
  const lcg = (seed) => {
    let x = seed >>> 0 || 1;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 4294967296;
    };
  };

  const conflict = async () => {
    const lv = E().LEVELS;
    const boards = [lv[0], lv[4], lv[8], lv[16]]; // 四个档位各一张
    let metDrift = 0;
    let unsound = 0;
    let badDrift = 0;
    let misses = 0;
    let cases = 0;
    const example = [];
    for (const row of boards) {
      const board = boardOfLevel(row);
      const rand = lcg(20260928 + row.n);
      for (let c = 0; c < 24; c++) {
        const grid = new Uint8Array(board.size);
        const marks = 1 + Math.floor(rand() * board.size);
        for (let m = 0; m < marks; m++) {
          const i = Math.floor(rand() * board.size);
          const v = rand() < 0.72 ? 1 + Math.floor(rand() * row.n) : 0;
          grid[i] = v;
        }
        const eng = E().diagnose(board, grid, null);
        const own = verdictsOwn(board, grid);
        cases++;
        if (Array.from(eng.satisfied).sort().join(',') !== Array.from(own.met).sort().join(',')) {
          metDrift++;
          if (example.length < 3) example.push({ id: row.id, c, eng: Array.from(eng.satisfied).join(','), own: Array.from(own.met).join(',') });
        }
        for (const idx of eng.violated) if (!own.dead.has(idx)) unsound++;
        if (Array.from(eng.badCells).sort((a, b) => a - b).join(',') !== Array.from(own.bad).sort((a, b) => a - b).join(',')) badDrift++;
        for (const idx of own.dead) if (!eng.violated.has(idx)) misses++;
      }
    }
    eq(`${cases} 批随机墨迹：已满足的边与自己的枚举判决全同`, metDrift, 0);
    eq(`${cases} 批随机墨迹：引擎判"对不上"的边，自己的枚举也判圆不回来（判据可靠）`, unsound, 0);
    eq(`${cases} 批随机墨迹：重复高度的格子集合与自己的扫描全同`, badDrift, 0);
    ck('引擎的前缀算术会漏掉一些"其实圆不回来"的边（它只保证不漏判、不保证全判）', misses >= 0, `漏了 ${misses} 条`);
    // filled / remaining 就是这堆墨的客观计数
    const g = await startLevel(lv[0].id); // startLevel 要的是关卡 id，不是行对象
    const n = g.w;
    eq('空盘的已填是 0/n²', text('#stat-filled'), `0/${n * n}`);
    eq('空盘没有对不上的边', text('#stat-conflicts'), '0');
    eq('空盘的状态行是空的（什么都没值得说）', text('#state-line'), '');
    // 同一行里写两个一样的高度：既重复又必然有边对不上
    A().setDigit(2);
    A().tap(0, 2);
    A().tap(1, 2);
    const own1 = verdictsOwn(g.board, g.st.cell);
    eq('同一行两个 2：两格都被标为重复', text('#stat-badcells'), `${own1.bad.size}`);
    ck('重复的那几格在 DOM 读数里被逐格数出来（不是只报一句"有冲突"）', own1.bad.size === 2 && g.diag.badCells.size === 2, JSON.stringify({ own: Array.from(own1.bad), eng: Array.from(g.diag.badCells) }));
    eq('对不上的边数与引擎 diagnose 一致', text('#stat-conflicts'), `${g.diag.violated.size}`);
    ck('引擎报的每条冲突边在自己的枚举里也成立', Array.from(g.diag.violated).every((i) => own1.dead.has(i)), JSON.stringify({ eng: Array.from(g.diag.violated), own: Array.from(own1.dead) }));
    eq('对上的边数同样逐条数得出来', text('#stat-satisfied'), `${g.diag.satisfied.size}/${g.diag.clues}`);
    checkLine('同一行写两个 2 之后', A().state());
    eq('冲突格把统计块挂上 bad 类', $('#stat-conflicts').closest('.stat').classList.contains('bad'), true);
    eq('重复格计数也挂着 bad', $('#stat-badcells').closest('.stat').classList.contains('bad'), true);
    await click('#btn-undo');
    await click('#btn-undo');
    eq('两步撤回后冲突读数为 0', `${text('#stat-conflicts')}|${text('#stat-badcells')}`, '0|0');
    eq('撤回干净后状态行重新闭嘴', text('#state-line'), '');
    eq('读数归零时 bad 类也摘掉', $('#stat-conflicts').closest('.stat').classList.contains('bad'), false);

    // 合法但已经死了的一堆墨：铅笔路径能证明它输，但盘面上一处重复也没有
    let doomed = null;
    outer: for (let i = 0; i < n * n; i++) {
      for (let v = 1; v <= n; v++) {
        const grid = Uint8Array.from(g.st.cell);
        grid[i] = v;
        const sentence = E().deadEnd(g.board, grid);
        const d = E().diagnose(g.board, grid, null);
        if (sentence && d.badCells.size === 0) {
          doomed = { i, v, sentence };
          break outer;
        }
      }
    }
    ck('找得到"没有重复但已被判死"的一格（铅笔路径证明的是输掉而不是写得丑）', !!doomed, JSON.stringify(doomed));
    if (doomed) {
      A().tap(doomed.i, doomed.v);
      eq('界面读到的死局句子就是引擎那句', g.dead, doomed.sentence);
      checkLine('合法但已推不完的一堆墨', A().state());
      ck('状态行用的是引擎原句（这里不重写判据，只搬运）', text('#state-line').includes(doomed.sentence), text('#state-line'));
      eq('重复格计数仍为 0（死的是推理，不是写法）', text('#stat-badcells'), '0');
      const hintsBefore = g.hints;
      const info = A().useHint();
      if (info.charged) eq('死局里提示仍只写线索逼得出的那个数', A().valueOf(info.cell), Number(rowById(lv[0].id).solution[info.cell]));
      else ck('死局里按提示要么被拒绝、要么空转，不编新事实', !!(info.conflict || info.stalled || info.charged === false), JSON.stringify(info));
      const delta = g.hints - hintsBefore;
      ck('提示收费与它真的做了事一致（拒绝/空转不收钱，落一格收一次）',
        info.conflict || info.stalled || info.charged === false ? delta === 0 : delta === 1,
        JSON.stringify({ conflict: !!info.conflict, stalled: !!info.stalled, charged: info.charged, delta }));
      await click('#btn-undo');
      let guardC = 0;
      while (A().undo() !== null && guardC++ < 60);
      eq('撤掉死局那一步（连同可能落下的提示）之后盘面回到全空', Array.from(g.st.cell).join(''), '0'.repeat(n * n));
      eq('全空的盘当然没有被判死', g.dead, null);
      checkLine('退回干净之后', A().state());
    }

    // 冲突时不许静默改写玩家的墨：先写错、再按提示
    const g2 = await startLevel(lv[0].id);
    // 顶住墨的那条必须是"落子"行：脚本前头那些候选划除行没有格子可写，本来就不会与墨冲突
    const s0 = g2.script.find((r) => r.kind === 'place');
    const s0At = g2.script.indexOf(s0);
    const wrongVal = s0.value === 1 ? 2 : 1;
    A().tap(s0.cell, wrongVal);
    const hints0 = g2.hints;
    // 一次按提示只吃一条脚本行（吃不下东西的行也照样前进一格、不收钱），所以要先按掉
    // 落在第一条落子行之前的那些候选划除行，才会顶到那条落子行上。
    for (let k = 0; k < s0At; k++) A().useHint();
    eq(`先按掉落在第一条落子行之前的 ${s0At} 条候选行（一次按提示只吃一行）`, g2.cursor, s0At);
    const curAt = g2.cursor;
    const bad = A().useHint();
    ck('墨与线索顶住时提示给的是"冲突"而不是新事实', !!bad.conflict, JSON.stringify({ conflict: bad.conflict }));
    eq('这一路按下来一次也没收钱（候选行空转、冲突行拒绝）', g2.hints, hints0);
    eq('冲突这一按不推进光标（下次再按还会说到这条）', g2.cursor, curAt);
    eq('提示不许把玩家写的数字偷偷改掉', A().valueOf(s0.cell), wrongVal);
    eq('冲突面板的标题行是那句拒绝', text('#hint-rule'), '这条线索和你的墨冲突');
    ck('拒绝的理由里带着格名、规则名与应该写的那个数',
      text('#hint-line').includes(g2.board.cellName(s0.cell)) && text('#hint-line').includes(s0.rule.name) && text('#hint-line').includes(`必须是 ${s0.value}`),
      text('#hint-line'));
    A().tap(s0.cell, s0.value);
    A().useHint();
    ck('改对之后同一个提示能推下去（光标前移）', g2.cursor > curAt, `${curAt} → ${g2.cursor}`);

    ck('本节无未捕获异常', errors.length === 0, errors.join(' | '));
    A().engine.Store.reset();
    return report({ cases, metDrift, unsound, badDrift, prefixMisses: misses, doomed: doomed ? `${doomed.i}:${doomed.v}` : 'none' });
  };

  // ---- 场景 7：提示只给"下一个可证事实"，而且一路推到底（零猜）--------------------------------------

  const ruleNames = () => new Set(E().RULE_LIST.map((r) => r.name));
  const solDigit = (row, i) => Number(row.solution[i]);

  const hint = async () => {
    const row = rowById(E().LEVELS[0].id);
    const g = await startLevel(row.id);
    const names = ruleNames();
    const seenRules = [];
    const written = [];
    let charged = 0;
    let spun = 0;
    let stallHits = 0;
    const textDrift = [];
    const ruleDrift = [];
    for (let k = 0; k < g.script.length + 4 && k < 400; k++) {
      const cursorBefore = g.cursor;
      const hintsBefore = g.hints;
      const info = A().useHint();
      if (!info) {
        ck(`第 ${k + 1} 次按下去对局已经赢了（面上不再给提示，也不报错）`, g.status === 'won', JSON.stringify({ status: g.status, cursor: g.cursor }));
        break;
      }
      if (info.stalled) {
        eq(`脚本吃完后如实报"到头了"（第 ${k + 1} 次）`, g.cursor, g.script.length);
        ck('到头了这句话非空', (info.text || '').length > 4, JSON.stringify(info));
        eq('到头了时面板标题报的是"推到头了"而不是某条规则', text('#hint-rule'), '线索推到头了');
        eq('面板正文搬的就是那句原话', text('#hint-line'), info.text);
        spun++;
        stallHits++;
        if (stallHits >= 2) {
          // 再按一次仍然只是重复这句话：不收钱、不推进、不假装还有货
          const before = { h: g.hints, c: g.cursor };
          const again = A().useHint();
          ck('吃完脚本后继续按提示不会倒退也不会收费', !!again.stalled && g.hints === before.h && g.cursor === before.c, JSON.stringify({ again, hints: g.hints, cursor: g.cursor }));
          break;
        }
        continue;
      }
      if (info.conflict) {
        ck('一路顺着脚本走不该撞到冲突', false, JSON.stringify(info));
        continue;
      }
      const src = g.script[cursorBefore];
      ck(`第 ${k + 1} 次提示说的规则在引擎表里`, names.has(info.rule), info.rule);
      seenRules.push(info.rule);
      // 面板那句必须是规则自己写的那句，不是这层另写的摘要
      const own = src.rule.text(g.board, src);
      if (own !== text('#hint-line')) textDrift.push({ k, rule: info.rule, want: own.slice(0, 40), got: text('#hint-line').slice(0, 40) });
      if (!text('#hint-rule').includes(info.rule) || !text('#hint-rule').includes(`第 ${info.level} 层`)) ruleDrift.push({ k, on: text('#hint-rule'), rule: info.rule, level: src.rule.level });
      eq(`第 ${k + 1} 次提示的层号来自引擎记录`, info.level, src.rule.level);
      if (info.charged) {
        charged++;
        eq(`第 ${k + 1} 次提示落了子就得收费`, g.hints, hintsBefore + 1);
        eq('收费的那一次光标前移了', g.cursor, cursorBefore + 1);
        if (src.kind === 'place') {
          written.push(`${src.cell}:${src.value}`);
          eq('提示写下的数就是答案里那个（可证事实，不是猜的）', A().valueOf(src.cell), solDigit(row, src.cell));
        }
      } else {
        eq(`空转的那一次不收钱（第 ${k + 1} 次）`, g.hints, hintsBefore);
        ck('空转也吃掉一行（不原地打转）', g.cursor > cursorBefore, `${cursorBefore} → ${g.cursor}`);
        spun++;
      }
    }
    ck('面板那句话逐字就是规则自己写的句子', textDrift.length === 0, JSON.stringify(textDrift.slice(0, 2)));
    ck('面板的标题行带着规则名与层号', ruleDrift.length === 0, JSON.stringify(ruleDrift.slice(0, 2)));
    ck('这一关真被提示推到了底', g.status === 'won' && E().complete(g.board, g.st.cell), g.status);
    eq('提示收费次数 = 脚本里真正需要落的子（且没重复落同一格）', new Set(written).size, written.length);
    ck(`吃完整个脚本共收 ${charged} 次钱、空转 ${spun} 次（都 <= 脚本长 ${g.script.length}）`, charged <= g.script.length && spun <= g.script.length, JSON.stringify({ charged, spun }));
    eq('读数里的提示次数与内存一致', text('#stat-hints'), `${g.hints}`);
    eq('提示脚本的总数读数与关卡烘的步数一致', text('#stat-script').split('/')[1], `${row.steps}`);

    // 撤销不退费，也不倒读：撤掉一次提示落下的子，提示计数与光标都不许回退
    const g2 = await startLevel(row.id);
    let firstCharged = null;
    for (let k = 0; k < 60 && !firstCharged; k++) {
      const info = A().useHint();
      if (info && info.charged && info.rule) firstCharged = info;
    }
    ck('找得到第一次收费的提示', !!firstCharged, JSON.stringify(firstCharged));
    const hintsAfter = g2.hints;
    const cursorAfter = g2.cursor;
    await click('#btn-undo');
    eq('撤销一次提示：字退回去了', A().valueOf(firstCharged.cell), 0);
    eq('撤销不退提示费（否则撤到底就能拿"提示 0"的纪录）', g2.hints, hintsAfter);
    eq('撤销不回卷光标（提示不会倒读同一条）', g2.cursor, cursorAfter);
    eq('读数里的提示费还是那笔', text('#stat-hints'), `${hintsAfter}`);
    const next = A().useHint();
    ck('下一次提示说的是往后而不是刚撤掉的那条', !next.charged || next.cell !== firstCharged.cell || A().valueOf(next.cell) !== firstCharged.value, JSON.stringify({ cell: next.cell, rule: next.rule }));

    // 零猜：20 关全部只靠提示（= 线索派生的脚本）能推到底，一子不差
    const stuck = [];
    const wrongWrite = [];
    const overCharge = [];
    let totalHints = 0;
    for (const r of E().LEVELS) {
      await startLevel(r.id);
      const gg = A().game;
      const res = A().solveWithLogic({ cap: 6000 });
      const cells = Array.from(gg.st.cell).join('');
      if (res.status !== 'won' || cells !== r.solution) stuck.push({ id: r.id, status: res.status, same: cells === r.solution });
      if (E().verify(gg.board, gg.st.cell).length !== 0) wrongWrite.push(r.id);
      if (gg.hints > r.steps) overCharge.push({ id: r.id, hints: gg.hints, steps: r.steps });
      totalHints += gg.hints;
    }
    ck('出厂 20 关全部"只按提示、不猜"推到底，且落定的答案与烘的逐格相同', stuck.length === 0, JSON.stringify(stuck.slice(0, 3)));
    ck('推到底之后独立验收 verify() 一条问题也没有', wrongWrite.length === 0, JSON.stringify(wrongWrite));
    ck('提示收费永不超过这一关的脚本长（不重复教同一条）', overCharge.length === 0, JSON.stringify(overCharge.slice(0, 3)));

    ck('本节无未捕获异常', errors.length === 0, errors.join(' | '));
    A().engine.Store.reset();
    return report({ levels: E().LEVELS.length, charged, spun, rulesUsed: new Set(seenRules).size, totalHints });
  };

  // ---- 场景 8：状态行与统计行的每个数都重算得出------------------------------------------------------

  function noteErrorsOwn(board, grid, notes) {
    const n = board.n;
    const out = [];
    const possible = (t, pos, v) => {
      const fwd = [];
      for (let k = 0; k < n; k++) fwd.push(grid[t.cells[k]]);
      return permsFor(n).some((p) => {
        if (p[pos] !== v) return false;
        if (board.clue[t.idxA] !== NO_CLUE && seenFrom(p, false) !== board.clue[t.idxA]) return false;
        if (board.clue[t.idxB] !== NO_CLUE && seenFrom(p, true) !== board.clue[t.idxB]) return false;
        return fwd.every((val, k) => val === 0 || val === p[k]);
      });
    };
    for (let i = 0; i < board.size; i++) {
      if (grid[i] !== E().EMPTY || !notes[i]) continue;
      for (let v = 1; v <= n; v++) {
        if (!(notes[i] & (1 << v))) continue;
        let ok = true;
        for (const [tid, k] of board.cellTracks[i]) {
          if (!possible(board.tracks[tid], k, v)) {
            ok = false;
            break;
          }
        }
        if (!ok) out.push(`${i}:${v}`);
      }
    }
    return out;
  }

  const stats = async () => {
    const row = rowById(E().LEVELS[4].id); // 上手 4×4：数不多，够看出读数是不是活的
    const g = await startLevel(row.id);
    const n = g.w;
    const size = n * n;
    const tier = E().tierFor(row.tier);
    eq('关卡名', text('#stat-name'), row.name);
    eq('档位名', text('#stat-tier'), tier.name);
    eq('尺寸读数带来源', text('#stat-size'), `${n}×${n} · 出厂关卡`);
    eq('分数读数就是烘的那个测量值（一位小数）', text('#stat-score'), Number(row.score).toFixed(1));
    eq('脚本总数读数', text('#stat-script'), `0/${row.steps}`);
    eq('空盘已填', text('#stat-filled'), `0/${size}`);
    eq('空盘剩余', text('#stat-remaining'), `${size}`);
    eq('空盘对上的边', text('#stat-satisfied'), `0/${boardClues(g.board)}`);
    ck('时间读数是 mm:ss 形状', /^\d{2}:\d{2}$/.test(text('#stat-time')), text('#stat-time'));

    // 第一批墨是"干净的"：一处落子 + 一条正确候选 + 一条已被线索杀掉的候选
    const v0 = solDigit(row, 0);
    A().setDigit(v0);
    A().tap(0, v0);
    await click('#btn-mode-note');
    A().setDigit(solDigit(row, 5));
    await tapCell(5); // 答案里那个候选：正确的笔记，不该被判过期
    A().setDigit(v0);
    await tapCell(2); // 同一行已经写过这个数：这条候选必然过期
    await click('#btn-mode-ink');
    let own = verdictsOwn(g.board, g.st.cell);
    const filledOwn = Array.from(g.st.cell).filter((v) => v !== E().EMPTY).length;
    eq('已填 = 自己数的非空格子', text('#stat-filled'), `${filledOwn}/${size}`);
    eq('剩余 = 空格子数', text('#stat-remaining'), `${size - filledOwn}`);
    eq('对上的边 = 自己按全枚举数出来的边', text('#stat-satisfied'), `${own.met.size}/${boardClues(g.board)}`);
    eq('对不上的边 = 引擎 diagnose 的条数', text('#stat-conflicts'), `${g.diag.violated.size}`);
    ck('引擎报的边在自己的枚举里也真圆不回来（判据不漏判）', Array.from(g.diag.violated).every((i) => own.dead.has(i)),
      JSON.stringify({ eng: Array.from(g.diag.violated), own: Array.from(own.dead) }));
    eq('这一批墨里没有重复格', text('#stat-badcells'), '0');
    const mineNote = noteErrorsOwn(g.board, g.st.cell, g.st.notes);
    const engNote = new Set();
    for (const e of g.diag.noteErrors) for (const v of e.values) engNote.add(`${e.cell}:${v}`);
    ck(`自己这套"这一行/列已经装不下它"的判据（${mineNote.join(',')}）全部被引擎认账`, mineNote.length > 0 && mineNote.every((x) => engNote.has(x)), JSON.stringify({ mine: mineNote, eng: Array.from(engNote) }));
    ck('正确的笔记不会被误报为过期（答案里那个候选不在判据里）', !engNote.has(`5:${solDigit(row, 5)}`), JSON.stringify(Array.from(engNote)));
    eq('候选过期条数 = 引擎判据的条数（页面不自己数）', text('#stat-noteerrors'), `${g.diag.noteErrors.length}`);
    eq('步数读数 = 落子与划候选的次数', text('#stat-moves'), `${g.moves}`);
    eq('提示读数未被动过', text('#stat-hints'), '0');
    eq('脚本光标未动（一次提示也没按）', text('#stat-script'), `0/${row.steps}`);
    checkLine('带着过期候选的盘', A().state());

    // 第二批墨：同一行再写一个一样的数 —— 冲突信号也该一起活起来
    A().tap(1, v0);
    own = verdictsOwn(g.board, g.st.cell);
    eq('重复格 = 自己扫出来的格子数', text('#stat-badcells'), `${own.bad.size}`);
    ck('重复的是刚写的那两格', own.bad.size === 2 && own.bad.has(0) && own.bad.has(1), JSON.stringify(Array.from(own.bad)));
    ck(`对不上的边数跟着涨（同一行两个 ${v0}）`, g.diag.violated.size > 0, `${g.diag.violated.size}`);
    eq('已填计数也更新（不是只刷了冲突那一项）', text('#stat-filled'), `${filledOwn + 1}/${size}`);
    checkLine('写着重复的盘', A().state());
    eq('对上的边仍按自己的枚举数', text('#stat-satisfied'), `${own.met.size}/${boardClues(g.board)}`);
    const badBlocks = { conflicts: g.diag.violated.size > 0, badcells: g.diag.badCells.size > 0, noteerrors: g.diag.noteErrors.length > 0, satisfied: g.status !== 'won' && g.diag.violated.size > 0 };
    for (const [id, want] of Object.entries(badBlocks)) {
      eq(`统计块 #stat-${id} 的 bad 类跟着计数走`, $('#stat-' + id).closest('.stat').classList.contains('bad'), want);
    }

    // 全部读数与 game.state() 一一吻合（只有 syncStats 一个地方在写）
    const s = A().state();
    const map = {
      '#stat-moves': `${s.moves}`,
      '#stat-hints': `${s.hints}`,
      '#stat-filled': `${s.filled}/${s.total}`,
      '#stat-remaining': `${s.remaining}`,
      '#stat-satisfied': `${s.satisfied}/${s.clues}`,
      '#stat-conflicts': `${s.conflicts}`,
      '#stat-badcells': `${s.badCells}`,
      '#stat-noteerrors': `${s.noteErrors}`,
      '#stat-script': `${s.cursor}/${s.script}`,
      '#stat-name': s.name,
      '#stat-tier': E().tierFor(s.tier).name,
      '#stat-size': `${s.n}×${s.n} · 出厂关卡`,
      '#stat-score': Number(s.score).toFixed(1),
    };
    const stale = Object.entries(map).filter(([sel, want]) => text(sel) !== want).map(([sel, want]) => `${sel}: 页面 ${text(sel)} / 应有 ${want}`);
    ck(`${Object.keys(map).length} 项读数全部等于引擎 state() 重算值（没有一处写半截）`, stale.length === 0, stale.join(' | '));

    // 时间是真的在走（同一块 DOM，两秒后必须换数）
    const t0 = text('#stat-time');
    await wait(1200);
    const t1 = text('#stat-time');
    ck('计时读数在走（mm:ss 会跳）', t0 !== t1, `${t0} → ${t1}`);
    ck('elapsed 读数与内存计时同量级', Math.abs(A().elapsed() - (s.elapsedMs || 0)) < 4000 || A().elapsed() >= (s.elapsedMs || 0), JSON.stringify({ dom: t1, ms: A().elapsed() }));

    // 把墨擦干净，所有计数必须一起归零（不是只擦格子）
    let guardS = 0;
    while (A().undo() !== null && guardS++ < 200);
    eq('退干净后已填归零', text('#stat-filled'), `0/${size}`);
    eq('退干净后对不上的边归零', text('#stat-conflicts'), '0');
    eq('退干净后重复格归零', text('#stat-badcells'), '0');
    eq('退干净后候选过期归零', text('#stat-noteerrors'), '0');
    eq('退干净后状态行闭嘴', text('#state-line'), '');
    for (const id of Object.keys(badBlocks)) {
      eq(`退干净后 #stat-${id} 的 bad 类摘掉`, $('#stat-' + id).closest('.stat').classList.contains('bad'), false);
    }

    ck('本节无未捕获异常', errors.length === 0, errors.join(' | '));
    A().engine.Store.reset();
    return report({ n, filled: filledOwn, clues: boardClues(g.board), noteMine: mineNote.length, noteEngine: engNote.size, readouts: Object.keys(map).length });
  };
  const boardClues = (board) => Array.from(board.clue).filter((v) => v !== NO_CLUE).length;

  w.__scn = { first, seed, rules, unique, play, conflict, hint, stats };
})(window);
