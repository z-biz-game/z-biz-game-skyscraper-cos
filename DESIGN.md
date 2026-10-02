# DESIGN · 摩天楼 Skyscraper

工程侧的分解与动机。与 `README.md` 的分工：README 写承诺，本文写**为什么这些承诺是可以用命令检查的**。

本轮所有数字都是我自己重跑的（HEAD `1a2f479`、Node `v26.8.1`、macOS、2026-09-28 01:06 CST 同一次会话）。
**代码 > 本文**：本文与 `js/`、`tools/` 冲突时以代码为准。本轮量到 **6 处**代码注释或 UI 文案与实测对不上，
全部列在 §10（正文里出现"注释与实测不一致"字样的两处是 §4 与 §5），本文没有替它们圆场，也没有改代码。

**下一轮（HEAD `11881a5`，同机 02:20–02:30 CST）动了代码**：独立穷举器从"只在 `bake --check` 里说话"
接进了出题路径（`js/engine/generate.js:253`，预算 `PROOF_BUDGET = 40,000,000` 节点，`:65`）。
上面那一句"没有改代码"只描述 `1a2f479` 那一轮，不覆盖这一改动之后。本文受影响的地方已按新行号与新读数重钉：
§5 的那处"注释与实测不一致"（§10 第 3 条）**已闭合**，§9 的成本表多了两行，§10 新增两条留着没改的。
`11881a5` 之后我重跑了全部五道闸：五档分位表、全线索墙、reject 统计、出厂 20 关四个分数**逐字未变**，
`js/data/levels.js` 逐字节相同（sha256 `de7d828afd7299d1a8c77852b08ae6073cb1f7b978dc492a526aacfd0b47de0a`，
在 `1a2f479`、`11881a5` 与工作树三处都相同），引擎单测 1879 → 1976 条，浏览器闸仍是每形 507 条、0 失败。

代码注释里点名要这一份文件的七处是 `js/engine/skyscraper.js:25`（→ §2）、
`js/engine/skyscraper.js:347`（→ §4）、`js/engine/generate.js:23`（→ §5）、`js/engine/perm.js:9`（→ §5）、
`js/engine/perm.js:14`（→ §3）、`js/engine/generate.js:357`（→ §8）、`tools/bake.mjs:18`（→ §8）。

---

## §1 模块分解

依赖是单向的、自下而上：`engine/*` → `data/levels.js` → `library.js` → `main.js`，
`ui/game.js` 与 `render/board.js` 各取一块夹在中间（两者都**只**读 `engine/*`，`render/board.js` 另读 `theme.js`；
两者都不读 `library.js`），
`tools/` 反过来读 `js/`，**`js/` 永不 import `tools/`**。

| 模块 | 职责 | 不该出现在这里的东西 |
| --- | --- | --- |
| `js/engine/perm.js` | `n!` 排列表、`visible()` / `visibleBack()`、`compatible()`、`NO_CLUE = -1`、`MAX_N = 8` | 任何棋盘概念 |
| `js/engine/skyscraper.js` | 盘与线（`tracks`）、铅笔路径（`propagate`/`derive`/`solve`）、13 条规则与其**句子**、独立验收 `verify()`、逐边体检 `diagnose()`、玩家墨的状态机 | 回溯搜索（搜索只在 `count.js`） |
| `js/engine/count.js` | 第二套（`countSolutions`）与第三套（`countNaive`）穷举意见，自带一份"能看见几栋"的实现 | 任何推理规则 |
| `js/engine/generate.js` | 先种拉丁方再读边（`cluesFrom`）→ 贪心删线索（`pruneClues`）→ 按带择优（`generate`）→ 五档 `TIERS` | 时间、`Math.random()` |
| `js/engine/rng.js` | `dateSeed()`：日期 → `YYYY-MM-DD` 键与 `epochDays` | 生成用的随机源（生成器用的是 `generate.js:67` 的 `mix()`，两套互不相同） |
| `js/data/levels.js` | **bake 的产物**，20 关：`clue` 串 + `solution` 串 + 印出的测量 + `PROOF` + `TIERS_META` | 手写内容（文件头 `js/data/levels.js:1` 写明 "Do not edit by hand"） |
| `js/library.js` | 内容层：线索串编解码、`CHAPTERS`、按档解锁、日课换档 | 判定（它只重组引擎给的读数） |
| `js/store.js` | 一个 localStorage 键 + RLE + 三层清洗（`sanitizeRuns`/`sanitizeBest`/`sanitizeResume`） | 线索集（存档只带 `(seed, tier)` 和墨） |
| `js/ui/game.js` | 可玩状态机：一次手势 = 一步撤销、`hint()` 走的是**线索**推出来的脚本、胜利判定用 `verify()` | 自己写一句提示文案（见 §4） |
| `js/render/board.js` | Canvas 绘制 + 命中几何（`layoutFor`），与 `hitCell` 共用同一份布局 | 任何判断（"这条边对上了"来自引擎） |
| `js/theme.js` `js/audio/synth.js` | 色板/间距/动效/触控下限的单一来源；WebAudio 合成音效 | 硬编码副本（CSS 通过 `--touch-min` 拿同一个数） |
| `js/main.js` | 接线 + `window.skyscraper` / `window.App` 双面（`js/main.js:922-923`） | 判定（注释在 `js/main.js:1-4` 就划了这条线） |
| `tools/engine-test.mjs` | 1976 条断言、9 节，纯 Node | 浏览器 |
| `tools/balance.mjs` | 现场抽题量阶梯，两道人审 | 读任何写死的表（`tools/balance.mjs:1-3`） |
| `tools/bake.mjs` | 写 `levels.js`，并用 `--check` 把每个印出的数字重算回去 | 墙钟时间 |
| `tools/verify.sh` `tools/playtest.cjs` `tools/scenarios.js` | 真 Chrome + CDP：DOM 几何、画布像素、真 localStorage，两种 URL 形态各一遍 | 内部标志位（断言只读 DOM/像素/存档） |
| `tools/doctest.mjs` | 文档数字闸：README/DESIGN 印出的每一个现值都从引擎当场重算再对，分 D1–D14 十四组，全跑 276 条断言 | 抄文档里的数（它只认自己重算出来的那一版） |
| `tools/sabotage.mjs` | 破坏台账：把每一类谎各写回树里一遍，要求 `tools/doctest.mjs` **点名**变红，再从内存里那份字节恢复 | 用 git 恢复（本工作区禁用那几条命令，见 §7 最后一行） |

一个刻意的事实：`countNaive` **只在 `tools/` 和页内测试场景里被调用**；`countSolutions` 在 `js/` 里只有一个调用点，
就是出题那一张（`js/engine/generate.js:253`，`11881a5` 起）。出货的浏览器运行时（`js/main.js` 那条路径）
从不跑穷举计数。唯一性是**出厂前**证明的，不是玩家等到的。

## §2 表示层：两个哨兵为什么不是同一个数

`EMPTY = 0`（空格，`js/engine/skyscraper.js:26`）与 `NO_CLUE = -1`（这条边没印数，`js/engine/perm.js:92`）
是两个不同的数，虽然两者都写 0 也能跑。理由写在 `js/engine/skyscraper.js:23-25`：它们住在**不同的数组**里，
一次"复用了另一个哨兵"的编辑就足以让整套线索静默消失。这个决定不是洁癖，它有闸：

- `count.js` 用**自己**的 `NOTHING = 0` / `ABSENT = -1`（`js/engine/count.js:18-19`），并且开局就把
  "线索位写 0" 当成致命错误抛出去（`js/engine/count.js:60`）。
- 引擎侧 `clueIndex = side*n + line`，`SIDES = ['上','右','下','左']`（`js/engine/skyscraper.js:28`、`:50`）；
  `count.js` **重新**从游戏规则推了一遍这个布局（`topLeft = clue[3n+r]` 等，`js/engine/count.js:56-59`）。
  于是布局漂移的表现是两套实现给出不同答案，而不是在一个共享 helper 里一致地错。
- 引擎单测第一节 `哨兵与盘的构造`（52 条，`tools/engine-test.mjs:149`）钉住这两点。

其他表示层事实（都是本轮实测）：一条线两端的读数加起来 `> n+1` 在**构造阶段**抛错（`js/engine/skyscraper.js:99`）；
线索串格式是 `4n` 个字符、`.` 表示空边，`bake.mjs` 里有一份**故意不与 `library.js` 共享**的编解码器
（`tools/bake.mjs:65-78` vs `js/library.js:19-35`）——两份解码不一致的表现为 `--check` 变红
（`m.clueRoundTrip`，`tools/bake.mjs:179`）。

## §3 三套（页内四套）互不信任的实现

"唯一解"这句话如果只有一个实现支持，它就是这个仓最贵的一句形容词。现在的分工：

| # | 实现 | 它信任什么 | 位置 |
| --- | --- | --- | --- |
| 1 | 铅笔路径 `solve()` | 不回溯、不读玩家的墨；每条规则写的都是"本线每一种相容摆法都同意" | `js/engine/skyscraper.js:590` |
| 2 | 逐格回溯计数器 `countSolutions(cap=2)` | 自带一份 `towersVisible()`、自带前缀剪枝、数不完就报 `OVERBUDGET` 而不是猜 | `js/engine/count.js:27`、`:48` |
| 3 | 朴素拉丁方枚举 `countNaive()` | 搜索途中**一个线索都不用**，只在方阵成形后把边读出来对 | `js/engine/count.js:157` |
| 4 | `squares4()`：本文件从零造的 4 阶全部 576 个拉丁方 | 与前三套无一行代码共享 | `tools/engine-test.mjs:473` 一节 |

`#1` 与 `#2/#3` 的关系是**单向的**，这点必须写清楚：铅笔路径的每一写都在**每一个解**里成立，
所以"推得完 ⇒ 唯一"是可靠的；反向不成立（规则集不完备），所以 `#2`/`#3` **不能**用来证明"能推到底"，
只能用来证明"解的个数"。三套的交集就是出货判据：`bake --check` 要求同一张盘
`铅笔推到底 ∧ 穷举判 UNIQUE 且逐格同解 ∧ 朴素枚举判 1 个解且同解`，本轮 20/20 全中。

`11881a5` 之后 `#2` 说话的地方多了一处，而且是最要紧的一处：**出题路径本身**。
`js/engine/generate.js:253` 在候选盘进入择优打分之前先调 `countSolutions(board, {cap: 2, budget: PROOF_BUDGET})`，
`OVERBUDGET` / `MANY` / `NONE` / 与铅笔 `derived` 逐格不一致四类全数拒绝。
在此之前，这张盘能不能出货只由 `#1` 一票决定，`#2` 只在事后（`bake --check`、`balance`）被问一句——
**"两个实现互不信任"和"两个实现都被同一条路径采信"不是同一件事**，前者可以退化成后者没人发现。

`#3` 的价钱有天花板：4 阶 576 个拉丁方、5 阶 161,280 个（公开常数，`tools/bake.mjs:251` 直接对答案），
6 阶 812,851,200 个——所以 6 阶只钉首行（1,128,960 个 = 9408 × 5!），**它不能单独证明 6 阶全局唯一**，
那一票始终在 `countSolutions` 手上（`tools/balance.mjs:145`）。

再往外部锚一层：可见数分布 `c(n,k)` 由 Stirling 递推 `c(n,k)=c(n-1,k-1)+(n-1)·c(n-1,k)` 给出，
与 `distribution(n)` 的枚举结果逐位对拍，且 `Σ_k c(n,k) = n!`（`tools/bake.mjs:253-268`、`tools/balance.mjs:231-240`）。
本轮实测 `4: 6,11,6,1`／`5: 24,50,35,10,1`／`6: 120,274,225,85,15,1`，两条路一致。
`balance.mjs:226-230` 还留着一条自嘲：这一行初稿把一行**乘**起来而不是加，`6·11·6·1 = 396 ≠ 24`，红了一次构建才修对。

## §4 铅笔路径：规则表、实测深度，和两条从不显形的 Hall 规则

`solve()` 每轮扫全部 `2n` 条线（`propagate`，`js/engine/skyscraper.js:392`），顺序是"人伸手会先摸什么"：

1. 单边自解释：`只见一栋`（层 1）/ `一栋不落`（层 1）/ `第一格的顶`（层 2，权重 0.6）—— 权重与层级写在 `js/engine/skyscraper.js:149-169`。
2. 两头一起读：`最高楼的位置`、`最高楼只有一格可站`（都是层 2，`:170-183`）。
3. 整行相容排列集：`排列集排除候选` / `整行相容排列集` / `这个数只剩一格可放`（层 3，`:184-204`，`surviving()` 在 `:540`）。
4. Hall 家族：`几个数只挤得下几格` / `几格只装得下这几个数`（层 4，权重 3.4 / 3，`:226-239`；`hallSweep()` 在 `:348`，调用点 `:503`）。
   两端都没线索的线走便宜的全异分支：`同行不重复`（层 1）/ `候选只剩一个`（层 2）/ `这一行只剩一格`（层 2）（`:205-225`）。

分数是**这条脚本的成本**：`score = Σ (place ? weight : weight × 被划掉的候选数)`，深度是用到过的最大 `level`
（`js/engine/skyscraper.js:596-608`）。

实测（本轮，§11 探针 D 的原始输出；其中"开过火 10 种"和"沉默的那三条的名字"同时被引擎单测第九节 `规则开火普查` 钉成了断言，`tools/engine-test.mjs:1505`、那一节的 `sec()` 在 `:1544`、两条计数断言在 `:1557`、`:1558`）：

- 出厂 20 关共 **1512 步**，只开火 **10 种**规则：
  `排列集排除候选 738 / 整行相容排列集 374 / 第一格的顶 190 / 最高楼的位置 79 / 只见一栋 45 / 同行不重复 33 /
  一栋不落 15 / 最高楼只有一格可站 14 / 候选只剩一个 14 / 这一行只剩一格 10`。
- **沉默 3 条**：`这个数只剩一格可放`、`几个数只挤得下几格`、`几格只装得下这几个数`（单测按名字钉死了这三条，
  `tools/engine-test.mjs:1558`，所以"哪条规则从不显形"本身是受保护的读数而不是传说）。
- 各档出厂盘用到的规则种数：novice 8 · casual 9 · regular 10 · sharp 9 · master 9。
- **规则深度上限在全部两处抽样里都是 3**：`SAMPLES=24` 的分位表里五档 `规则深度` 全是 3；
  出厂 20 关里最深的一关也是 3。也就是说第 4 层（两条 Hall）**没有一张出货盘用到过**。
- 我做了个对照实验（**在 `/tmp` 的引擎副本上，仓里代码未改）**：把 `hallSweep()` 的调用整行摘掉，
  同一批 `wall-<n>-<k>` 种子的全线索可推完率**一字不变**（4 阶 70/120、5 阶 53/120、6 阶 6/120、7 阶 0/120），
  五档现场各 24 题也仍然 24/24 造得出来。
  → **注释与实测不一致**：`js/engine/skyscraper.js:345-347` 说 Hall "exactly the gap that makes a fully clued 6x6
  stall without them"，本轮这个因果不复现。Hall 在数学上确实严格强于逐格支持检查，但在**这条阶梯产生的盘上它没有活可干**。
  这一轮只写文档，代码没动。
- 同一条不一致会漏到玩家脸上：出厂章节标题 `六阶的 Hall 家族` 与大师档的文案
  "几格候选挤在同样几格里，Hall 家族才解得开"（`tools/bake.mjs:95`、`js/main.js:524`）承诺 Hall 是大师档的钥匙，
  而**同一个菜单**的规则表会打印"这条规则在这 20 关里开火 0 次（沉默）"（`js/main.js:587`、`:592-593`）。
  本轮实测：4 张出厂 master 关的深度都是 3。

提示的可证性：提示**不写文案**，它把规则自己的句子原样搬出来（`report()` → `row.rule.text(board, row)`，
`js/ui/game.js:233-246`），所以面板上的话和推导证明的东西不可能各说一套；每条规则文本都必须能点名它靠哪条边
（`cluePair()`，`js/engine/skyscraper.js:259`）。玩家的墨与线索矛盾时，`hint()` 返回矛盾说明、**不写格、不计提示**
（`js/ui/game.js:199-205`）。

## §5 阶梯：`band` / `target` / `tries` 是被 reject 统计逼出来的

这一档只有两个旋钮：**印几个数**（`target`，删线索删到这里）和**留多少张盘可挑**（`tries` + `band` 择优）。
`extras`（把线索还回去）在出货阶梯里是**死的**：五档全是 `extras: 0`（`js/engine/generate.js:341-345`），
`resupply()` 只被单测直接跑。

逼出这五个数的统计（本轮，`SAMPLES=24 node tools/balance.mjs`；前两类是 `1a2f479` 那轮的，第三类是 `11881a5` 加的）：

1. **墙**：`4n` 条线索全印上，铅笔路径能不能从空盘推到完 —— 4 阶 70/120（58.3%）、5 阶 53/120（44.2%）、
   6 阶 6/120（5.0%）、**7 阶 0/120（0.0%）**。这行数字就是"没有 7×7 档"的全部理由：
   7 阶要么放弃"唯一"、要么放弃"推到底"，两个都不在可谈的范围内（`js/engine/generate.js:15-23`）。
   `n=6 < n=5` 的顺序本身也是断言（`tools/balance.mjs:83`）。
2. **reject 统计**：每档造 24 题要采多少张盘、按什么理由丢。
   初学 46 张（全线索推不动丢 16 = 34.8%）、上手 53（21 = 39.6%）、熟练 214（131 = 61.2%）、
   高阶 99（57 = 57.6%）、大师 547（520 = **95.1%**）。
   "删到 `target` 之后反而推不动"的丢弃数**五档全是 0** —— 这个数字很关键：它证明 `pruneClues` 的接受条件
   （`progress` 不许下降，`js/engine/generate.js:163`）确实在把关，而不是把烂盘交给下游的 `stalled`。
3. **穷举举证台账**（`11881a5` 起，`balance` 多打的一张表）：每档交给 `countSolutions` 的候选盘
   30 / 32 / 83 / 42 / 27 张，**证完数与交给数逐档相等**，四类拒绝全 0，最贵一次证明 3,395,743 节点（大师档）。
   这一张表的读数与上面两类 reject **口径不同**：只有铅笔推得完的盘才交得到穷举器手上，
   所以"交给穷举 83 张"发生在"采样 214 张"的下游，两者不能相减。

`tries` 是从这条尾巴上加了倍数得来的（`js/engine/generate.js:329-339` 记录了 60 种子实测尾巴 6/9/28/15/60，
以及 `pruneClues` 修好之前是 6/32/33/131/630；本轮 24 题口径下大师采到 547 张，与 1,400 的上限还有一倍余量）。
**尾巴会不会被复核吃掉？** 会改变的是"能用的盘更少了"，而不是"要采更多张"——`11881a5` 之后 24 题口径下
大师仍然 24/24 出货、`tries` 上限 1,400 没动、上面五个 reject 计数一字未变，所以这一段本轮不需要重抄。
至于 `generate.js:22` 那句"timed a master board, uniqueness re-check included, at p50 38 ms / p90 194 ms"：
`1a2f479` 那一轮它是**假**的（`balance.mjs:109-111` 的计时只包住 `makePuzzle`，而那时 `makePuzzle` 里没有复核），
这一轮它是**真的**了——复核就插在 `makePuzzle` 的候选盘进打分之前，那两列 `ms` 现在含着它。
但对不上的地方换了一种：同一台机器本轮读到的是 **45 / 256 ms**，不是 38 / 194。
墙钟随负载变，注释里钉一个绝对毫秒数本身就是个会过期的说法，所以这条留在 §10 第 3 条里当**已闭合但留痕**处理，
代码未再改。

`band` 与 `target` 的耦合方式值得单独一句：**同一阶的两个档位只差 `target`**。
初学／上手都是 4 阶（14 个数 vs 9 个），熟练／高阶都是 5 阶（18 vs 12）。
这条不是解释，是断言：`tools/balance.mjs:220-221` 要求 `casual` 的线索数**少于** `novice`、
`sharp` 的少于 `regular`，否则"线索轴根本没起作用"。

日课按天在五档上轮转（`dailyPuzzle` → `TIERS[epochDays % TIERS.length]`，`js/library.js:135-141`）。
本轮实测：`verify` 的 `seed` 场景把 `daily:2026-03-14` 钉成 `dailyTier: casual`，两种 URL 形态都对，
且 7 条 seed 指纹由 Node 侧原样重算（`tools/verify.sh:111-159`）。

## §6 出厂内容：一行是一次测量，不是一次请求

`js/data/levels.js` 是 `tools/bake.mjs` 写的，`--check` 做**两件互相独立**的事（`tools/bake.mjs:13-18`）：

1. **语义**：每张盘从 `clue` 串重建盘 → 跑铅笔路径 → 跑 `countSolutions` → 跑 `countNaive`，
   与印在文件里的 `score / steps / places / prunes / eliminated / rounds / clues / depth / solution / topRule`
   **逐字段**比（`measure()` 与 `verifyRow()`，`tools/bake.mjs:154`、`:183`），还要反过来用答案串把 `4n` 条边
   重数一遍对得上印出来的线索（`tools/bake.mjs:196-203`）。
2. **文本**：内存里重生成整个文件，要求与磁盘上那份**逐字节相同**（`tools/bake.mjs:374-375`）。

本轮 `--check` 输出的五档出厂分数：`62.2/61.9/55.6/50.8`（novice）、`67.8/62.8/65.3/68.5`（casual）、
`111/119.4/125.9/125`（regular）、`138.2/130.8/136.5/136.7`（sharp）、`232.7/223.6/218.7/228.5`（master）；
`深度` 20 关全是 3；总计"唯一解 20 / 推到底 20 / 朴素同判 20"。

**测量 vs 请求**这条区别是这一节的要点：`campaign()` 的接受条件是
"种子族 `campaign|<tier>|<j>` 里第一批落进 `band` 且线索串不重复的盘"（`tools/bake.mjs:101-109`），
所以出厂池是**截断样本**。它和 `balance` 的现场分位表是两个总体，中位数不可互换（README 有专门一节讲这件事）。

## §7 闸：六道 Node 闸 + 一道浏览器闸，两种 URL 形态

| 闸 | 命令 | 它到底在拦什么 |
| --- | --- | --- |
| 语法 | `npm run check`（`package.json:15`） | 每个 `js/**`、`server.cjs`、两个 `electron/*.cjs`、`tools/*.mjs`、`tools/scenarios.js` 能被解析。**注意**：`tools/scenarios.js` 是被 `node --check` 而不是被喂给 node 跑（`check` 脚本里那句"未落地，跳过"是留给还没写的场景文件的） |
| 引擎保证 | `node tools/engine-test.mjs` | 1976 条断言 / 9 节（`11881a5` 前 1879）；期望值是**纸上演算写死的字面量**，绝不从求解器读回来（`tools/engine-test.mjs:1-15`） |
| 阶梯 | `node tools/balance.mjs` | 入带率 + 中位数严格递增 + 线索轴生效 + Stirling 行 + 每样本三套实现对拍，**外加逐题的穷举举证账**：`handed ≥ 1 && proved ≥ 1`、`交给它 = 证完 + 四类拒绝`、`maxNodes < proof.budget` 压线即红（`tools/balance.mjs:133-137`）。CI 口径是 `SAMPLES: "12"`（`.github/workflows/ci.yml:43`），文档口径是 24 |
| 出厂重算 | `node tools/bake.mjs --check` | §6 的语义 + 逐字节两件事 |
| 文档数字 | `node tools/doctest.mjs` | README/DESIGN 印出去的每一个现值：阶梯表、入带率与中位链、拒绝统计、穷举台账、墙探针、出厂 20 关的三票、规则开火普查、`>>>FIXTURE` 夹具表、端口与 `SAMPLES` 口径、`file:NN` 引用（142 条范围 + 57 条锚点）、`DESIGN.md §N` 的"几处"那句自己、D1–D14 十四组与 `EXPECT_ROWS` 自钉。它**不重测墙钟**，也不抄文档的数：全部当场重算 |
| 破坏台账 | `node tools/sabotage.mjs` | 全绿不等于闸会红。六把刀逐把把一类谎写回树里（`TIERS` 带、出厂关卡的线索串、README 那句"1976 条"、`verify.sh` 的 want 端口、`js/` 反向 import `tools/` 那一类缺席检查、`scenarios.js` 夹具字段），每把都要求 doctest `rc≠0` **且**点名它杀的那条断言，FAIL 行原文留在日志里；恢复用的是下刀前读进内存的那份字节（不是 `git checkout`/`restore`——本工作区禁用），盖回台账的 rc 是真读回来的 |
| 浏览器 | `bash tools/verify.sh` | 真 Chrome：DOM 几何、画布像素、真 localStorage。**两种形态各 8 场景 = 507 条**（`tools/verify.sh:33` 的注册表）。前四道 Node 闸从建仓起就在 CI 里跑，这一条不是——`browser` 作业是 `5c59352` 才加的，同一 SHA 的 runner 日志里两个步骤各自 `success`。表中后两道（文档数字、破坏台账）与 `bash tools/verify.sh` 里的那两条逻辑闸是同一条命令，CI 没有只属于自己的门 |

`verify.sh` 为什么要把同一组场景跑两遍（根 `5313`、前缀 `5323/<repo>/`）：根形态是本地服务器能**意外**满足的形态，
而 Pages 是 `/<repo>/` 前缀 —— 一个写死的 `/js/...` 在前缀下 404，而一次抛断的动态 import 会把注入脚本的**后半截**
一起带走，看起来像"绿得少了几条"（`tools/verify.sh:15-19`、`tools/scenarios.js:20-22`）。

形态之外的三件事也是这一档在管的：

- **端口不借**：`5313 / 5323 / 9363` 是本仓专属；被占了就换下一个并**说出是谁占的**，
  从不杀不是自己起的进程（`tools/verify.sh:44-70`）。
- **夹具由 Node 重算**：`tools/scenarios.js` 里 `>>>FIXTURE` 那段盘指纹每次跑都被 Node 侧重算一遍
  （`tools/verify.sh:106-159`），否则它会烂成"上次 Chrome 印了什么就对什么"。本轮 `7/7 条 seed 指纹仍由 node 原样重算出来`。
- **软件光栅是禁区**：脚本头部明确写了不要加 `--use-angle=swiftshader` —— 画布像素是这半套断言的**证据**，
  假光栅会让它说谎（`tools/verify.sh:21-23`）。

本轮 `verify` 尾行：`=== ALL GREEN（两种 URL 形态的全部场景）===`，每形 `first 43 + seed 27 + rules 58 + unique 50 +
play 49 + conflict 37 + hint 198 + stats 45 = 507 条`，0 失败。

## §8 确定性：墙钟时间不进任何选择键

一个盘 = `(seed, tier)`，别的什么都不是。存档因此只需要 `(seed, tier)` 加玩家的墨
（`Store.saveResume`，`js/store.js:234-255`；注释在 `js/store.js:1-4`），日课、浏览器、bake、验证台
拿到的是**同一个盘**。

这条纪律在代码里的落点（都可 grep）：

- 生成器的随机源是 `mix(seed)`（xorshift32，`js/engine/generate.js:67`），**没有** `Math.random()`、
  **没有** `Date.now()` 参与选择；`makePuzzle` 被明确要求是 `(seed, tier)` 的纯函数（`js/engine/generate.js:356-359`）。
- **新接进来的那道复核同样不进墙钟**：`countSolutions` 的停止条件是**节点**（`PROOF_BUDGET = 40,000,000`，
  `js/engine/generate.js:65`、调用点 `:253`），不是 `performance.now()`。这条是"能不能把证明放进出题路径"的前提——
  放进去的若是毫秒预算，那么"哪一张候选盘先跑完预算"就成了选择键的一部分——同一 seed 在快机器与慢机器上
  会抽出两张盘，本节这条纪律当场作废。兄弟仓里抓到的形状是另一条同源的路径（在 `sort` 的比较器里抽随机数，
  于是 node 与 Chrome 各画一张盘），教训一样：**选择键里不许有任何跨环境不重的东西**。
  本轮实测的支撑：浏览器与 Node 用同一预算重出的 7 张盘，**连"为落进带内采了几张盘"的 `gen` 计数都相同**
  （1 / 1 / 14 / 7 / 5 / 12 / 1，`tools/scenarios.js:415-421`），`verify` 的 `seed` 场景逐格断言，`cellDiffs: 0`。
- `main.js` 里同样禁 `Math.random()`：开局顺序走 `walk` 计数器 + 日期种子
  （`js/main.js:106-117`），注释写得很直白——"一个没人能重复的种子就是一局存不回来的档"。
- **墙钟不进键**：`bake` 能做逐字节比对，前提就是文件里没有一个是时间戳（`tools/bake.mjs:16-18`）。
- 日课的换档来自 `epochDays % TIERS.length`（`js/library.js:137`），不是来自"今天是星期几"之类的口头约定。

一处**重复但不一致**的风险，本轮量到的是"暂时一致"：`dateSeed()` 的日期键在 `js/engine/rng.js:39-45` 和
`js/library.js:143-148`（私有 `dateSeedAt`）各有一份同逻辑实现，`main.js` 用前者、`library.js` 的日课用后者。
本轮两边今天都给 `2026-09-28`（`rng.js` 侧实测 `{"key":"2026-09-28","epochDays":20724}`），
但这个一致性只靠"两份代码相同"，没有断言钉。另注意 `js/engine/rng.js` 的 `makeRng`/`hash32`
在当前出货路径上**没有被任何模块 import**（只用了 `dateSeed`）。

`window.skyscraper` 与 `window.App` 是同一个对象的两个名字（`js/main.js:919-923`），
验证台走的是玩家那套提交路径（`surface.tap` / `surface.stroke`，`js/main.js:861-869`），
所以场景绿了等于真状态机绿了。

## §9 成本表

本轮同一次会话的量（Node 侧 `v26.8.1`，浏览器侧 headless Chrome 1280×1024 dpr 1）：

| 事项 | 实测 | 上限/口径 | 出处 |
| --- | --- | --- | --- |
| `npm run check` | 1.7 s | — | `11881a5` 本轮计时（`/usr/bin/time -p`） |
| `node tools/engine-test.mjs` | 9.4 s | **1976** 断言 / 9 节 | 本轮计时 |
| `node tools/bake.mjs --check` | 10.1 s | 20 关 × 三套实现 | 本轮计时 |
| `SAMPLES=24 node tools/balance.mjs` | 29.9 s（脚本自报同数） | 五档 × 24 + 480 张墙探针 | 本轮计时 |
| `bash tools/verify.sh` | 34.8 s | 507 × 2 形态 | 本轮计时 |
| 造一张大师盘（含择优**与唯一性复核**） | 本机 p50 45 ms / p90 256 ms | `tries ≤ 1400` | `balance` 的 `ms p50 / ms p90` 两列；`11881a5` 起这一计时包住复核（复核点在 `generate.js:253`，在打分之前）。`1a2f479` 那轮同一列是 12/23，那时它**不含**复核，两个数不可比 |
| 出题路径上的穷举举证 | 一轮 5×24 题共交 214 张候选盘、证完 214 张、四类拒绝各 0 | `PROOF_BUDGET = 40,000,000` 节点/盘 | `balance` 的台账表；`js/engine/generate.js:65`、`:253` |
| 最贵一次证明（同一轮） | 大师档 **3,395,743** 节点（＝预算的 8.5%）；单题最贵合计 3,528,691 | `balance` 断言 `maxNodes < budget`，压线即红 | 本轮台账；`tools/balance.mjs:137` |
| 穷举计数节点（出厂 20 关，按档最大） | novice 244 · casual 313 · regular 3378 · sharp 6641 · **master 731218** | `budget = 4,000,000`，且断言 `maxNodes < budget/4` | `tools/scenarios.js:752`、`:782`；Node 侧独立探针给出**同样的五个数** |
| 穷举计数节点（现场 24 题/档，按档最大） | 287 · 812 · 5223 · 20053 · **3,395,743** | `balance` 用 `60,000,000` | 本轮 A/B 探针；`tools/balance.mjs:41` |
| 朴素枚举叶数 | 4 阶 576 · 5 阶 161280 · 6 阶定首行 1128960 | 公开常数 12 / 576 / 161280 / 9408 | `tools/bake.mjs:251`、`:270-281` |

**同一轮里并存着三个不同的穷举预算**，这不是漂移，是三个不同的问题：出题要"证得起才敢出货"（40,000,000，
`generate.js:65`）；`balance` 与 `engine-test` 要"用一个比出题方更严的天花板去复核出题方有没有说谎"
（60,000,000，`tools/balance.mjs:41`、`tools/engine-test.mjs:740`、`:753`）；浏览器 `unique` 场景要"在页内
把出厂 20 关与按 seed 重搭的那 7 张盘再数一遍"（4,000,000，`tools/scenarios.js:752`，
运行时那 7 张走 `:797-806`，含一张 6 阶，全部 `UNIQUE` 且逐格同解）。
三者对**这两族盘**同时成立：出厂 20 关最大 731,218（最紧预算的 18%），7 张 seed 盘在 4,000,000 内证完。
**没有断言覆盖的是任意一张现场 6 阶盘**：本轮现场最大一张走到 3,395,743，已经吃掉 4,000,000 的 85%。
运行时页面自己**不再数第二遍**（全仓 `countSolutions` 的唯一调用点就是出题那一处，
`js/engine/generate.js:253`，预算 40,000,000），所以这条差额今天不会咬到玩家，只咬验证台：
> 4,000,000 的是**页内复算那一站**的天花板，出题那一站已经走到 40,000,000。差额记在 §10 第 7 条，不当已验证。

三条从这张表里读出来的判断，写下来免得下次重新猜：

1. `countSolutions` 的价钱是**按盘**变的，不是按阶变的：大师档出厂 4 关最多 731,218 节点，
   而同一档现场 24 张里最大一张走到 **3,395,743** —— 已经是 `bake`/`verify` 那个 4,000,000 预算的 85%。
   `balance` 把预算开到 60,000,000（`tools/balance.mjs:41`）正是为此；
   但**出厂内容之外的任何 6 阶盘一旦被拿去用 4,000,000 预算判唯一性，余量只有 1.18 倍**。
2. `tools/balance.mjs:30-34` 那句"一张稀疏 6×6 走了 18,377,715 个节点（2.3 s）"在本轮 24 个大师样本里没有复现
   （本轮最大 3,395,743）。同一句里"5 阶盘 well under 10,000 节点"也被本轮 5 阶样本打脸：
   `sharp` 现场 24 张里最大 **20,053**。这两句是**注释**，不是闸；`11881a5` 那轮改了出题路径，但**没有动这两行注释**，
   本轮重跑这两个读数仍然逐字复现（3,395,743 / 20,053）。
3. 深度上限恒为 3、Hall 恒不开火（§4），意味着阶梯的成本**全在第 3 层的排列集上**：
   出厂 20 关里 `排列集排除候选 + 整行相容排列集` 两类就占了 1112/1512 步。

## §10 已知不一致与未验证（工程侧）

代码/UI 文案 vs 本轮实测（`1a2f479` 那一轮**只记录、一行代码没动**；`11881a5` 之后下面第 2、3 条的状态已改写，
改写的原因写在条目里，不删条目）：

1. `js/engine/skyscraper.js:345-347`：Hall 家族"正是没有它就会让全线索 6×6 卡住的那道沟" ——
   摘掉 `hallSweep()` 调用后墙探针 70/53/6/0 一字不变，五档仍各 24/24 出货。
2. `tools/balance.mjs:30-34`：`18,377,715 节点（2.3 s）` 与 `5 阶 well under 10,000` 两个数，
   本轮 `SAMPLES=24` 实测分别是 max 3,395,743（大师）与 max 20,053（5 阶 sharp）。
   `11881a5` 那轮改出题路径时**没有动这两个注释**，也没有动 `balance` 的 60,000,000 天花板；
   本轮重跑这两个读数**逐字复现**（3,395,743 / 20,053 在 README 台账与 A/B 探针里各出现一次，同为这两个数）。
3. ~~`js/engine/generate.js:21-22`：大师 `p50 38 ms / p90 194 ms`、并说"uniqueness re-check included" ——
   本轮 12/23，而那个计时**不含**唯一性复核~~ → **`11881a5` 已闭合方向，没闭合数字**：复核现在真的在
   `makePuzzle` 里面（`generate.js:253`），`balance.mjs:109-111` 的计时因此确实包住了它，
   "re-check included"那句不再说谎；但同一台机器本轮读到的是 **45 / 256 ms**，注释写的 38 / 194 是另一轮负载下的读数。
   **绝对毫秒数不该钉在注释里**这件事仍然成立，注释本轮未再改（改它是文案工作，不是正确性问题）。
4. 出厂章节文案 `六阶的 Hall 家族` / "Hall 家族才解得开"（`tools/bake.mjs:95`、`js/main.js:524`）
   与同一菜单打印的"这条规则开火 0 次（沉默）"（`js/main.js:587`）互相打脸；4 张 master 关实测深度 3。
5. `tools/engine-test.mjs:17-25` 的章节清单列了 8 节，实际 `sec()` 调用是 9 个（缺
   `每一步都当场可验`，`tools/engine-test.mjs:658`），输出里也是 `章节 9 节`。
6. `js/main.js:135` 说 `availBox()` 的修法是"让 6×6 在手机上守住 `js/theme.js` 写的 44px 触控下限"，
   但渲染器的下限其实是 `Cell.min = 26`（`js/render/board.js:15`、`js/theme.js:58`）；
   `css/game.css:299` 与 `:446-449` 自己承认 390px 视口上曾经掉到 42px，并把 343 CSS px 当成守住 44 的先决条件
   （这一条我按 `layoutFor()` 反解确认算术成立：`(343-24)/(6+2×0.62) = 44.06`），但**真机掉不掉穿仍未实测**。
7. `11881a5` 带来的两条新缺口（本轮记下来，没修）：
   - **出题路径与验证台用的是两个预算，而且以后不会同时红**。运行时唯一的 `countSolutions` 调用点就是出题
     （`js/engine/generate.js:253`，40,000,000），页内 `unique` 场景与 `bake` 复算出厂池用的是 4,000,000
     （`tools/scenarios.js:752`）。今天两边都够（出厂最大 731,218，差 5.5 倍），但**出厂池将来若换进一张
     > 4,000,000 的盘，会只有验证台红、出货路径绿** —— 这是闸的次序问题，不是 bug，可是文档从没写过它。
     把它记在这儿，是因为下一次 `bake` 换盘的人会先看到红的那一半。
   - **出题路径的墙钟成本从此不可忽略**（大师 p90 256 ms / 本机，含复核；最贵一次证明 3,395,743 节点），
     而**没有一道闸测过浏览器里单次出题要多久**（`seed` 场景只比逐格结果，不比时间）。
     浏览器现在按最多 40,000,000 个数一张盘，低端手机上"点一下随机盘要等多久"是**未知的**，不是"已知很快"。

未验证（与 README 同一份，不重复解释）：Safari / Firefox / 移动端实机；
读屏与键盘-only 全流程；低端机时延与小屏几何；Electron 壳（本机无 `node_modules`、
无 `package-lock.json`，从未安装或启动，只有 `node --check`）；WebAudio 实际出声；多标签并发写同一存档键。

**Pages 这一条本轮从"未验证"改成了实测**（HEAD `5c59352`、2026-09-28 02:05）：远端已建、已推，
`BASE_URL=https://z-biz-game.github.io/z-biz-game-skyscraper-cos/ bash tools/verify.sh` 跑出 8 场景
**507 条、0 失败**，页内报 `base: /z-biz-game-skyscraper-cos/`（证明真站在前缀下、模块取到了），
`unique` 场景在真站上仍是 `maxNodes 731218 / budget 4000000`。两条留着没改：
那一次是**本机 Chrome 打线上产物**，跨浏览器与实机仍没人跑过；CI 跑的是根形态 + `ln -s` 搭出来的
前缀形态（`browser` 作业两步在 runner 上各 `success`，job 59 s），**CI 里没有"打真站"这一步**，
所以线上产物每次变更要靠推上去以后再手工跑一次，这是这套闸现在的真实形状。

## §11 复现这些数字

五条门禁（本页所有"实测"都出自这一串）：

```bash
cd /Users/zifang/workplace/ceo_workplace/z-biz-game/z-biz-game-skyscraper-cos
npm run check                        # → OK
node tools/engine-test.mjs           # → 断言 1976 条 · 通过 1976 · 失败 0 · 章节 9 节（末尾含规则开火普查）
node tools/bake.mjs --check          # → 20 关，每个印出的数字都从线索串重算（含五档出厂分数）
SAMPLES=24 node tools/balance.mjs    # → 全线索可行性表 + 五档分位表 + 拒绝统计 + 穷举举证台账 + == 结论 ：门禁全过 ==
bash tools/verify.sh                 # → === ALL GREEN（两种 URL 形态的全部场景）===，每形 507 条
```

两条**只读探针**，本页用它写成本表与"两套中位数"那一节；不写任何文件、不改任何代码：

```bash
# A. 出厂 20 关：按档列出印出的分数、中位数、步数中位、深度上限、穷举节点上限
node --input-type=module -e "
import { createBoard, solve } from './js/engine/skyscraper.js';
import { LEVELS } from './js/library.js';
import { countSolutions } from './js/engine/count.js';
const med = (a) => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
const dec = (n,t) => Int8Array.from([...t], (c) => c==='.'?-1:Number(c));
for (const k of ['novice','casual','regular','sharp','master']) {
  const rows = LEVELS.filter((l) => l.tier === k); let nodes = 0, depth = 0;
  for (const r of rows) {
    const b = createBoard({ n: r.n, clue: dec(r.n, r.clue) }); const s = solve(b);
    depth = Math.max(depth, s.depth); nodes = Math.max(nodes, countSolutions(b, { cap: 2, budget: 4000000 }).nodes);
  }
  console.log(k, '分数', rows.map((r) => r.score).join('/'), '中位', med(rows.map((r) => r.score)),
    '步数中位', med(rows.map((r) => r.steps)), '深度', depth, '节点max', nodes);
}"

# B. 现场抽题口径（与 A 不可互换）：每档 24 题的中位数、深度上限、穷举节点上限
node --input-type=module -e "
import { solve } from './js/engine/skyscraper.js';
import { countSolutions } from './js/engine/count.js';
import { TIERS, makePuzzle } from './js/engine/generate.js';
const med = (a) => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
for (const t of TIERS) {
  const sc = [], st = [], nd = []; let depth = 0;
  for (let k = 0; k < 24; k++) {
    const p = makePuzzle('balance-' + t.key + '-' + k, t.key); const s = solve(p.board);
    sc.push(p.score); st.push(p.steps); depth = Math.max(depth, s.depth);
    nd.push(countSolutions(p.board, { cap: 2, budget: 4000000 }).nodes);
  }
  console.log(t.name, '分数中位', med(sc), '步数中位', med(st), '深度', depth, '节点max', Math.max(...nd));
}"

# C. §4 的对照实验：在 /tmp 的引擎副本上摘掉 hallSweep() 调用，仓里代码不动
rm -rf /tmp/sky-halloff && mkdir -p /tmp/sky-halloff && cp -r js /tmp/sky-halloff/js
node -e "const fs=require('fs');const p='/tmp/sky-halloff/js/engine/skyscraper.js';
let s=fs.readFileSync(p,'utf8');s=s.replace('hallSweep(dv, t, atK, byV, steps);','// disabled');fs.writeFileSync(p,s)"
cd /tmp/sky-halloff && node --input-type=module -e "
import { createBoard, cluesFrom, solve } from './js/engine/skyscraper.js';
import { randomLatin, mix, makePuzzle } from './js/engine/generate.js';
for (const n of [4,5,6,7]) { let ok=0;
  for (let k=0;k<120;k++){ const g=randomLatin(n, mix('wall-'+n+'-'+k)); if(!g) continue;
    let b; try { b=createBoard({n, clue:cluesFrom(n,g)}); } catch { continue; }
    if (solve(b).ok) ok++; }
  console.log('去掉 Hall 后全线索可推完 n='+n+' → '+ok+'/120'); }
for (const t of ['novice','casual','regular','sharp','master']) {
  let m=0; for (let k=0;k<24;k++) if (makePuzzle('balance-'+t+'-'+k, t)) m++;
  console.log('去掉 Hall 后 '+t+' 现场仍造出 '+m+'/24'); }"

# D. §4 的规则开火普查（出厂 20 关逐步归类；引擎单测只钉"10 种"和沉默那三条的名字，明细靠这条）
node --input-type=module -e "
import { solve, rulesUsed, RULE_LIST } from './js/engine/skyscraper.js';
import { LEVELS, boardOfRow } from './js/library.js';
const fired = new Map(); const perTier = new Map(); let totalSteps = 0, depth = 0;
for (const row of LEVELS) {
  const b = solve(boardOfRow(row)); const use = rulesUsed(b.rows);
  for (const [k,v] of Object.entries(use)) fired.set(k,(fired.get(k)||0)+v);
  const pt = perTier.get(row.tier) || new Map();
  for (const [k,v] of Object.entries(use)) pt.set(k,(pt.get(k)||0)+v);
  perTier.set(row.tier, pt);
  totalSteps += b.rows.length; depth = Math.max(depth, b.depth);
}
console.log('总步数', totalSteps, '开火种类', fired.size, '深度上限', depth);
console.log([...fired.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+' '+v).join(' / '));
console.log('沉默', RULE_LIST.map(r=>r.name).filter(n=>!fired.has(n)).join('、'));
console.log('每档规则种数', [...perTier.entries()].map(([t,m])=>t+' '+m.size).join(' · '));
"
```

计时用同一条命令第二次跑得到的（Node 侧进程含启动，`verify` 含起 Chrome）：

```bash
for c in "npm run check" "node tools/engine-test.mjs" "node tools/bake.mjs --check" \
         "SAMPLES=24 node tools/balance.mjs" "bash tools/verify.sh"; do
  python3 -c "import time,subprocess;s=time.time();subprocess.run('$c',shell=True,
    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print('$c', round((time.time()-s)*1000),'ms')"
done
```

最后一句留给探针 B：它里面写死的 `budget: 4000000` 与 §9 那两行"穷举计数节点"是同一口径，
而本轮现场大师盘最贵一张已经走到 **3,395,743** —— 离这个 4,000,000 只剩 18% 的余量。
换一批种子或换一台更快的机器，这张盘一旦越过去，探针 B 打回来的就不是节点数而是"没数完"。
那时要动的是**探针与验证台的预算**（或补上 §10 第 7 条那条缺口），不是把 `balance` 的 60,000,000 天花板往下调——
下游天花板一旦往下调，"复核出题方"这件事就没人在场了。
