// 浏览器侧场景套件。由 tools/playtest.cjs 注入到真实页面里跑，两种 URL 形态（根 /
// Pages 的 /<repo>/ 前缀）各跑一遍。
//
// 断言纪律（照同组织已上线、闸跑通的 kakuro 仓 tools/scenarios.js 的口径）：读 DOM 几何与画布
// 像素，不读内部标志位。点一格要真的 dispatch PointerEvent、落子要真的走键盘/按钮、存档要真的从
// localStorage 反解回来比对。每个失败都打"当前值 vs 期望值"，每个通过也带着实测数字（坐标、像素
// 计数、格名）。
//
// window.skyscraper.engine 就是出货的那套引擎（main.js 把模块图整个挂上来），所以这里通过的
// 提示断言，等于玩家按提示走的那条路也通过。但"唯一解"和"线索语义"不许只信它：下面另写了
// 一份自己的可见数实现和一份自己的排列集枚举，三套互不信任地对拍（引擎自己的两套是
// js/engine/skyscraper.js 的铅笔路径与 js/engine/count.js 的穷举计数器）。
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

  // 第二套实现（js/engine/count.js）不在 main.js 挂出的面里 —— 它是出题/烘焙侧的工具模块，
  // 判据只 import 了铅笔路径那套。浏览器要拿它做"逐格复核"，就得自己在页内把它 import 进来，
  // 而且说明符必须从 document.baseURI 解析：这正是前缀形态要抓的那一类东西。
  let countMod = null;
  let countErr = '';
  async function counters() {
    if (!countMod) {
      try {
        countMod = await import(new URL('js/engine/count.js', document.baseURI).href);
      } catch (e) {
        countErr = String((e && e.message) || e);
      }
    }
    if (!countMod) throw new Error(`js/engine/count.js 在本形态下解不开：${countErr}`);
    return countMod;
  }

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
    ck('第二套实现（穷举计数器 + 朴素拉丁方枚举）在页内解得开', typeof C.countSolutions === 'function' && typeof C.countNaive === 'function', countErr || typeof C.countSolutions);
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

  w.__scn = { first, seed };
})(window);
