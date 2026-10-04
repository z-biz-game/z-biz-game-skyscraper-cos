#!/usr/bin/env bash
# One-shot browser verification: real headless Chrome, real DOM, real canvas pixels, real
# localStorage — in BOTH URL shapes this app is ever served in:
#
#   ① root    http://127.0.0.1:5313/                            (server.cjs: repo = document root)
#   ② prefix  http://127.0.0.1:5323/z-biz-game-skyscraper-cos/  (the GitHub Pages shape of
#                                                                https://z-biz-game.github.io/z-biz-game-skyscraper-cos/)
#
#   bash tools/verify.sh                       # both shapes, all scenarios
#   SHAPES=root bash tools/verify.sh           # one shape while editing
#   SCENARIOS="first geom" bash tools/verify.sh
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-skyscraper-cos/ bash tools/verify.sh
#                                              # the deployed artifact: one shape, nothing started
#
# Why the prefix shape is a separate run and not a footnote: root is the only shape a local server
# can fake by accident. A page-level `/js/...` specifier resolves fine when the repo *is* the
# document root and 404s under /<repo>/ — and a dynamic import that throws takes the rest of the
# injected script down with it, so a deployed site silently runs a fraction of the assertions. A
# gate that only ever saw the root shape cannot tell those two apart.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates every core and, with no CDP client attached, Chrome will not exit
# on its own. Canvas pixels are half the point of this file — a fake rasteriser makes them lie.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(basename "$HERE")                     # the Pages path segment, same as the repo slug
FEATURE=摩天楼                                # this app's own word: proof the bytes are ours
CDP_WANT=${CDP_PORT:-9363}
HTTP_WANT=${HTTP_PORT:-5313}
PREF_WANT=${PREFIX_PORT:-5323}
CHROME=${CHROME_BIN:-}
# tools/scenarios.js 里已注册的场景（顺序有讲究：续档配对 resume-a→b→c、脏存档 dirty-a→b→c）
SCENARIOS_DONE="first seed rules unique play conflict hint stats"
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
command -v python3 >/dev/null 2>&1 || { echo "需要 python3（前缀形态的静态服务器 + 结果解析）" >&2; exit 2; }
{ command -v "$CHROME" >/dev/null 2>&1 || [ -x "$CHROME" ]; } || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

# ---- ports ---------------------------------------------------------------------------------------
# 5313 / 5323 / 9363 belong to skyscraper and to nothing else in the family. A long-lived server on
# one of them happily serves a *different* app — or this same app out of an orphaned checkout, which
# a content pre-flight cannot catch. So: never borrow a bound socket, take the next free one and say
# out loud which one was taken by whom. Nothing here kills a process it did not start.
occupied() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }
squatters() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' '; }
first_free() {
  local base=$1 p
  for p in "$base" $((base + 100)) $((base + 200)) $((base + 300)); do
    if occupied "$p"; then
      echo "  端口 $p 已被别的进程听着（pid: $(squatters "$p")）——不借它的 socket，换下一个" >&2
    else
      echo "$p"; return 0
    fi
  done
  return 1
}

CUSTOM=0
[ -n "${BASE_URL:-}" ] && CUSTOM=1

if [ "$CUSTOM" = 0 ]; then
  CDP=$(first_free "$CDP_WANT") || { echo "no free devtools port near $CDP_WANT" >&2; exit 2; }
  HTTP=$(first_free "$HTTP_WANT") || { echo "no free http port near $HTTP_WANT" >&2; exit 2; }
  PREF=$(first_free "$PREF_WANT") || { echo "no free http port near $PREF_WANT" >&2; exit 2; }
  echo "ports: CDP $CDP (want $CDP_WANT) · root http $HTTP (want $HTTP_WANT) · prefix http $PREF (want $PREF_WANT)"
else
  CDP=${CDP_PORT:-9363}
fi

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP --user-data-dir=$UDD \
  --window-size=1280,1024 --no-first-run --no-default-browser-check about:blank >/tmp/skyscraper-chrome.log 2>&1 &
CPID=$!
SPID=0
PSPID=0
PROOT=""
cleanup() {
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  [ "$PSPID" != 0 ] && kill $PSPID 2>/dev/null
  kill -9 $CPID 2>/dev/null
  [ -n "$PROOT" ] && rm -rf "$PROOT"
  return 0
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and
# inside a pipeline it would hold the write end open long after the tests finished.
( sleep ${WD_TIMEOUT:-1500}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools later than a warm profile: wait on the endpoint.
for i in $(seq 1 120); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP (see /tmp/skyscraper-chrome.log)" >&2; exit 3; }

cd "$HERE"

FAILED=0

# ---- the node side of the seed pin ---------------------------------------------------------------
# tools/scenarios.js holds a table of board fingerprints computed by *node* out of the very module
# graph the page imports (js/library.js → js/engine/generate.js). Chrome has to reproduce them cell
# by cell. That only means something if node still produces them, so they are re-derived here on
# every run — a fixture nobody recomputes rots into "whatever Chrome printed last time".
echo "=== node re-derives the seed fixture pinned in tools/scenarios.js ==="
node --input-type=module --no-warnings -e "$(cat <<'NODEFIX'
import { readFileSync } from 'node:fs';
import { puzzleFromTier, dailyPuzzle, encodeClue } from './js/library.js';
import { solve } from './js/engine/skyscraper.js';

const src = readFileSync('tools/scenarios.js', 'utf8');
const cut = src.split('// >>>FIXTURE')[1];
const body = cut && cut.split('// <<<FIXTURE')[0];
if (!body) {
  console.log('  scenarios.js 里没有 // >>>FIXTURE … // <<<FIXTURE 这一段：跨引擎那一钉没东西可对');
  process.exit(1);
}
const want = JSON.parse(body.slice(body.indexOf('['), body.lastIndexOf(']') + 1));

const fp = (p) => ({
  n: p.n,
  clue: encodeClue(p.board.clue),
  solution: Array.from(p.solution).join(''),
  derived: Array.from(solve(p.board).derived).join(''),
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
});

let bad = 0;
for (const row of want) {
  const live = row.daily ? dailyPuzzle(new Date(2026, Number(row.daily.slice(5, 7)) - 1, Number(row.daily.slice(8, 10)))) : puzzleFromTier(row.tier, row.seed);
  if (!live) { console.log(`  FAIL ${row.seed}: node 这一侧出不了盘`); bad++; continue; }
  const got = fp(live);
  // row.seed / row.tier / row.daily 是夹具的寻址键，不是指纹字段
  const diff = Object.keys(row).filter((k) => k !== 'tier' && k !== 'daily' && k !== 'seed' && String(got[k]) !== String(row[k]));
  if (diff.length) {
    bad++;
    console.log(`  FAIL ${row.seed} node 重算与夹具不符: ${diff.map((k) => `${k} ${row[k]}→${got[k]}`).join(' / ')}`);
  }
}
console.log(`  ${want.length - bad}/${want.length} 条 seed 指纹仍由 node 原样重算出来（夹具是 node 的出货，不是 Chrome 的）`);
process.exit(bad ? 1 : 0);
NODEFIX
)" || FAILED=1

# ---- the two prose gates --------------------------------------------------------------------------------
# doctest 读 README/DESIGN 印出去的每一个现值，并当场从引擎重算（出厂 20 关重解+两个独立穷举器、每档 24 题
# 重造、开火普查、夹具表）。它自己数得出跑了多少条断言，所以这里再钉一次 DOCTEST_ROWS_WANT：整段被删的闸
# 不会留下任何 rc!=0 的痕迹，只有条数会。sabotage 是它的反证——每把刀必须把 doctest 弄红并点到大道的名。
# 两条都在 CI 的 check 作业里以同样的命令跑（node tools/doctest.mjs / node tools/sabotage.mjs）。
echo "=== node tools/doctest.mjs（文档数字闸）==="
DOCTEST_ROWS_WANT=${DOCTEST_ROWS_WANT:-276}
node tools/doctest.mjs >/tmp/skyscraper-doctest.log 2>&1
DOCTEST_RC=$?
grep -E '^  FAIL|^合计' /tmp/skyscraper-doctest.log | tail -20
DT_ROWS=$(sed -n 's/^rows: \([0-9]*\) .*$/\1/p' /tmp/skyscraper-doctest.log | tail -1)
echo "  doctest rc=$DOCTEST_RC rows=${DT_ROWS:-无 rows 行}（钉的是 ${DOCTEST_ROWS_WANT}）· 全量日志 /tmp/skyscraper-doctest.log"
[ "$DOCTEST_RC" = 0 ] || { echo "doctest FAILED：文档里的某个现值与代码/重算不符（见上面 FAIL 行）" >&2; FAILED=1; }
[ "${DT_ROWS:-0}" = "$DOCTEST_ROWS_WANT" ] || {
  echo "doctest 断言条数 ${DT_ROWS:-解析不到} ≠ 钉住的 $DOCTEST_ROWS_WANT —— 少一条就是有人删了一段检查却没改这一钉" >&2
  FAILED=1
}

echo "=== node tools/sabotage.mjs（破坏台账）==="
node tools/sabotage.mjs >/tmp/skyscraper-sabotage.log 2>&1
SAB_RC=$?
grep -E '^  (ERROR|刀红了|没红|对照|红得住)|^- K|^ledger' /tmp/skyscraper-sabotage.log | tail -24
echo "  sabotage rc=$SAB_RC · 全量日志 /tmp/skyscraper-sabotage.log"
[ "$SAB_RC" = 0 ] || {
  echo "sabotage FAILED rc=${SAB_RC}：有刀没能把文档闸弄红并点名（工作树脏时它也会以 rc=2 拒绝下刀）" >&2
  FAILED=1
}

# ---- one shape -----------------------------------------------------------------------------------
run_shape() {
  local shape=$1
  local base served boot s
  SPID=0
  PSPID=0
  PROOT=""
  if [ "$CUSTOM" = 1 ]; then
    base=$BASE_URL
  elif [ "$shape" = root ]; then
    base="http://127.0.0.1:$HTTP/"
    node "$HERE/server.cjs" "$HTTP" >/tmp/skyscraper-root-server.log 2>&1 &
    SPID=$!
  else
    # Pages shape: the repo lives under one path segment, served by a static file server whose root
    # is a directory that only *contains* a symlink to it. Nothing is copied or rewritten — that is
    # the point: a hard-coded `/js/...` has nowhere to hide in that shape.
    base="http://127.0.0.1:$PREF/$REPO/"
    PROOT=$(mktemp -d)
    ln -s "$HERE" "$PROOT/$REPO" || { echo "软链 $PROOT/$REPO 建不起来" >&2; return 1; }
    python3 -m http.server "$PREF" --bind 127.0.0.1 --directory "$PROOT" >/tmp/skyscraper-prefix.log 2>&1 &
    PSPID=$!
  fi
  BASE=$base
  if [ "$CUSTOM" = 0 ]; then
    for i in $(seq 1 40); do
      curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
      sleep 0.25
    done
  fi
  # Pre-flight: prove the bytes about to be tested are 摩天楼 itself, not some other repo's
  # index.html served on this port by an orphan process — and not a prefix URL that 404s.
  served=$(curl -fsS -m 5 "$BASE" 2>/dev/null || true)
  case "$served" in *js/main.js*) ;; *) echo "nothing served at $BASE (见 /tmp/skyscraper-*-log)" >&2; return 2 ;; esac
  case "$served" in *"$FEATURE"*) ;; *) echo "$BASE serving a different app (正文里找不到 $FEATURE)" >&2; return 2 ;; esac

  echo
  echo "################ shape=$shape  base=$BASE  (CDP :$CDP)"
  export CDP_PORT=$CDP
  export BASE_URL=$BASE
  node tools/playtest.cjs open "$BASE" | head -5

  boot=""
  for i in $(seq 1 60); do
    boot=$(node tools/playtest.cjs eval "window.skyscraper?window.skyscraper.version:'nope'" nonav 2>/dev/null | tr -d '\n" ')
    case "$boot" in *nope*|"") sleep 0.5 ;; *) break ;; esac
  done
  echo "boot: skyscraper $boot at $BASE"
  if [ "$boot" = "nope" ] || [ -z "$boot" ]; then echo "window.skyscraper never appeared at $BASE" >&2; return 4; fi

  # 默认跑已注册的那一组（每往 tools/scenarios.js 里加一组场景就把名字加进来）：`npm run verify`
  # 在任何一次提交上都必须是绿的，所以还没写完的名字不放进默认列表，只放 SCENARIOS= 里手工跑。
  for s in ${SCENARIOS:-$SCENARIOS_DONE}; do
    echo "=== [$shape] $s ==="
    node tools/playtest.cjs scenario "$s" 2>/tmp/skyscraper-$shape-$s.console.log | tail -1 | sed 's/^RESULT //' | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print('  NO RESULT (see /tmp/skyscraper-$shape-$s.console.log)'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception as e:
    print('  UNPARSED:', raw[:300]); sys.exit(1)
for r in d['rows']:
    if not r['pass']: print('  FAIL %-52s %s' % (r['test'], r['detail']))
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
if not d['rows']:
    print('  NO CHECKS RUN — a scenario that asserts nothing cannot be green'); sys.exit(1)
print('  %d checks, %d failed  %s' % (len(d['rows']), d['fail'], extra if extra else ''))
sys.exit(1 if d['fail'] else 0)
" || FAILED=1
    if [ -s /tmp/skyscraper-$shape-$s.console.log ]; then
      echo "  --- console ---"
      sed 's/^/  /' /tmp/skyscraper-$shape-$s.console.log | tail -12
    fi
  done
  return $FAILED
}

if [ "$CUSTOM" = 1 ]; then
  run_shape custom || FAILED=1
else
  for shape in ${SHAPES:-root prefix}; do
    run_shape "$shape" || FAILED=1
    # each shape gets its own servers; tear this one down before the next
    [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
    [ "$PSPID" != 0 ] && kill $PSPID 2>/dev/null
    [ -n "$PROOT" ] && rm -rf "$PROOT"
    SPID=0
    PSPID=0
    PROOT=""
  done
fi

kill $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN（两种 URL 形态的全部场景）===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
