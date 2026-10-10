// Wiring: DOM, pointer gestures, the clock, storage, and the `window.skyscraper` surface the
// verification harness drives. No judgement about the board lives here — whether a height breaks a
// printed count, what a hint is allowed to say, and when the board counts as finished all come from
// js/engine/skyscraper.js through js/ui/game.js. This file only moves ink and paints.

import { Palette, Cell, applyThemeVars, setReduceMotion, systemPrefersReducedMotion, prefersReducedMotion as motionReduced } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import { BoardView } from './render/board.js';
import * as Engine from './engine/skyscraper.js';
import { Game, INK, NOTE, EMPTY } from './ui/game.js';
import {
  TIERS,
  tierFor,
  LEVELS,
  PROOF,
  TIERS_META,
  CHAPTERS,
  chapterUnlocked,
  chapterProgress,
  levelById,
  boardOfRow,
  puzzleFromLevel,
  puzzleFromTier,
  dailyPuzzle,
} from './library.js';
import { dateSeed } from './engine/rng.js';

const VERSION = '1.1.0';

const $ = (sel) => document.querySelector(sel);
const el = {
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  chapters: $('#chapter-list'),
  clearedCount: $('#cleared-count'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  ruleTitle: $('#rule-title'),
  ruleList: $('#rule-list'),
  proofNote: $('#proof-note'),
  proofLine: $('#proof-line'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  dailyMeta: $('#daily-meta'),
  keypad: $('#keypad'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  size: $('#stat-size'),
  time: $('#stat-time'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  filled: $('#stat-filled'),
  remaining: $('#stat-remaining'),
  satisfied: $('#stat-satisfied'),
  conflicts: $('#stat-conflicts'),
  badCells: $('#stat-badcells'),
  noteErrors: $('#stat-noteerrors'),
  script: $('#stat-script'),
  score: $('#stat-score'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  stateLine: $('#state-line'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  canvas: $('#board'),
  // The box the canvas is measured against — see availBox().
  wrap: $('#board-wrap'),
  // Fullscreen is requested on #app rather than on <html>: #app owns the page padding and the
  // safe-area insets, so the fullscreen board keeps the very layout a phone sees.
  app: $('#app'),
  pauseVeil: $('#pause-veil'),
  pauseMeta: $('#pause-meta'),
  btnPause: $('#btn-pause'),
  btnRestart: $('#btn-restart'),
  btnFullscreen: $('#btn-fullscreen'),
};

const view = new BoardView(el.canvas);
let game = null;
let pulse = null;
let stroke = null;
let baseElapsed = 0;
let shown = 'menu';
let clockRunning = false;
let rafId = 0;
// 0 = "还没喂过任何一帧" 的哨兵，不是时间戳：见 update() 里的 dt 首帧口径。
let lastFrameAt = 0;
let dirty = false;
let lastShownSecond = -1;

// ---- one frame loop, dt everywhere ---------------------------------------------------------
// The run used to be timed by `setInterval(…, 1000)` and the hint ring by a `setTimeout`: both are
// wall-clock, and both kept running while the board was paused or the tab was hidden. Everything
// that moves is now advanced by one fixed-step accumulator, so a 30 Hz phone and a 120 Hz
// display agree to the last decimal on how far a run has got — the decay below is applied per
// *step*, and a step is always SIM_STEP seconds.
const SIM_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 8;
// Tolerance on the step boundary — see the accumulator loop in update().
const STEP_EPS = 1e-9;
// How long a named cell stays ringed after a hint, in virtual seconds. Not a transition (the
// Motion tokens are those, and they all sit in the 150–350 ms band) — it is the reading time for
// one sentence of prose.
const PULSE_S = 1.6;
const PULSE_PERIOD = 0.9; // one breath of the ring
// Per 1/60 s, so the amplitude after N steps is the same number at any refresh rate. Chosen so
// the ring has faded to ~0.35 by the time its window closes — gone enough to stop pulling the eye,
// there enough that the last glance still finds the cell a hint named.
const PULSE_DAMP = 0.989;

const sim = {
  frames: 0,
  frameDt: 0, // seconds the last frame reported
  accumulator: 0, // virtual seconds not yet consumed by a fixed step
  steps: 0, // fixed steps taken since load
  animClock: 0, // virtual seconds of animation rendered
  runSeconds: 0, // virtual seconds this run has been on the clock
  pulseAge: 0,
  pulsePhase: 0,
  pulseScale: 1,
};

// A run's clock is (what the archive said when the board was reopened) + (virtual seconds since
// this window opened it), so 继续 does not hand out a fresh timer, and a paused board stops
// counting — the number that ranks a record is time looked at, not time elapsed.
const clock = () => baseElapsed + Math.round(sim.runSeconds * 1000);
const running = () => clockRunning;

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const stat = (id) => el[id].closest('.stat');
function setStat(id, text, bad) {
  el[id].textContent = text;
  const box = stat(id);
  if (box) box.classList.toggle('bad', !!bad);
}

function stepSim(s) {
  sim.animClock += s;
  // Paused freezes *everything* that moves: the run's clock, the hint ring's breath, its timeout.
  // The accumulator above keeps filling, which is what makes the freeze frame-rate independent
  // rather than a slow leak.
  if (paused) return;
  if (clockRunning && game && game.status !== 'won') {
    sim.runSeconds += s;
    dirty = true;
  }
  if (!pulse) return;
  sim.pulseAge += s;
  if (sim.pulseAge >= PULSE_S) {
    pulse = null;
    sim.pulseAge = 0;
    sim.pulseScale = 1;
    dirty = true;
    return;
  }
  if (!motionReduced()) {
    sim.pulsePhase = (sim.pulsePhase + s / PULSE_PERIOD) % 1;
    sim.pulseScale *= Math.pow(PULSE_DAMP, s * 60);
  }
  dirty = true;
}

// The rAF callback body, factored out so a harness can feed it a virtual clock and settle the
// frame-rate question with numbers instead of adjectives.
function update(now) {
  sim.frames++;
  // `lastFrameAt === 0` is a sentinel, not a timestamp: the first frame reports dt 0 instead of
  // "since the epoch", so a harness whose virtual clock starts at 0 loses a frame nobody notices.
  const elapsed = lastFrameAt ? (now - lastFrameAt) / 1000 : 0;
  lastFrameAt = now;
  // A throttled tab hands back one huge dt on return. Clamping bounds the catch-up instead of
  // running thousands of fixed steps inside a single frame.
  sim.frameDt = Math.min(0.25, Math.max(0, elapsed));
  sim.accumulator += sim.frameDt;
  let guard = 0;
  // STEP_EPS absorbs the ms→s representation error: 1000/60/1000 is not bit-identical to 1/60, so
  // a bare `>= SIM_STEP` would let 60 Hz skip a step one frame in while 120 Hz skips it another —
  // a visible 16 ms per-3 s drift between refresh rates, i.e. exactly what this loop exists to kill.
  while (sim.accumulator + STEP_EPS >= SIM_STEP && guard++ < MAX_STEPS_PER_FRAME) {
    sim.accumulator = Math.max(0, sim.accumulator - SIM_STEP);
    sim.steps++;
    stepSim(SIM_STEP);
  }
  // Anything past the cap is dropped rather than banked: a two-minute backgrounded tab must not
  // spend its first visible second replaying it.
  if (sim.accumulator > SIM_STEP * MAX_STEPS_PER_FRAME) sim.accumulator = 0;
  const secs = Math.floor(clock() / 1000);
  if (secs !== lastShownSecond) {
    lastShownSecond = secs;
    el.time.textContent = fmtMs(clock());
    dirty = true;
  }
  if (dirty) {
    dirty = false;
    draw();
  }
}

function loop(now) {
  rafId = requestAnimationFrame(loop);
  update(now);
}

function startLoop() {
  if (rafId) return rafId;
  rafId = requestAnimationFrame(loop);
  return rafId;
}

// ---- which board an opening gets ---------------------------------------------
// The campaign rows tools/bake.mjs re-verified are handed out first, walked in tier order, and after
// them come generated boards whose seed is derived from the calendar day — so two players who open
// 熟练 on the same afternoon get the same numbers, and neither of them gets a board nobody measured.
// `Math.random()` is deliberately absent from this file: a run is stored by seed, so a seed nobody
// can repeat would be a save that cannot be resumed.
const walk = new Map();
function openingFor(tierKey) {
  const rows = LEVELS.filter((l) => l.tier === tierKey);
  const i = walk.get(tierKey) || 0;
  walk.set(tierKey, i + 1);
  if (i < rows.length) return puzzleFromLevel(rows[i]);
  return puzzleFromTier(tierKey, `day|${dateSeed().key}|${tierKey}|${i - rows.length}`);
}

// Today's board, asked for once and then held: the menu card has to name the tier the daily is
// actually sitting on, and reading the answer off the puzzle object is the only way that card cannot
// drift from what 日课 按钮 opens. Rotating the rung is library.js's job (`dailyPuzzle`), not a
// formula restated here. Re-keyed by date, so a tab left open past midnight gets tomorrow's board.
let dailyCache = null;
function dailyBoard() {
  const key = dateSeed().key;
  if (!dailyCache || dailyCache.dateKey !== key) dailyCache = dailyPuzzle();
  return dailyCache;
}

// How much room the canvas may take: the board is sized from #board-wrap's own content box — the
// element it is actually painted into — instead of from a subtracted guess, so the cell size the
// renderer picks and the space the layout has are the same measurement. Reading clientWidth forces a
// layout flush, and show() clears the view's `hidden` before it draws, so in a browser this is the
// real width; the fallback only covers a wrap measured while still hidden. On a phone the difference
// is what keeps a 6×6 grid at the 44 px touch floor js/theme.js states instead of sliding under it.
function availBox() {
  const wrapW = el.wrap.clientWidth || Math.max(240, window.innerWidth - 40);
  return { w: Math.max(240, wrapW), h: Math.max(240, window.innerHeight - 220) };
}

function draw() {
  if (!game) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  view.draw(game, {
    pulse,
    cursor: game.selected,
    preview: stroke && stroke.items.length ? { cells: stroke.items.map((s) => s.cell) } : null,
    // The ring's breath comes from the fixed-step loop rather than from a CSS transition, so it
    // freezes with the pause and holds the same shape at 30 Hz and at 120 Hz.
    pulseFx: { scale: sim.pulseScale, phase: sim.pulsePhase, age: sim.pulseAge / PULSE_S },
  });
}

// One place writes the readouts, so a number cannot be updated by half the file and left stale by
// the other half. Every figure below is the engine's own verdict via Game.state().
function syncStats() {
  if (!game) return;
  const s = game.state();
  el.name.textContent = s.name;
  el.tier.textContent = tierFor(s.tier).name;
  el.size.textContent = `${s.n}×${s.n} · ${KIND_NAME[s.kind] || s.kind}`;
  el.time.textContent = fmtMs(clock());
  setStat('moves', s.moves, false);
  setStat('hints', s.hints, false);
  setStat('filled', `${s.filled}/${s.total}`, false);
  setStat('remaining', s.remaining, false);
  setStat('satisfied', `${s.satisfied}/${s.clues}`, s.status !== 'won' && s.conflicts > 0);
  setStat('conflicts', s.conflicts, s.conflicts > 0);
  setStat('badCells', s.badCells, s.badCells > 0);
  setStat('noteErrors', s.noteErrors, s.noteErrors > 0);
  setStat('script', `${s.cursor}/${s.script}`, false);
  el.score.textContent = s.score == null ? '—' : Number(s.score).toFixed(1);
  el.stateLine.textContent = stateLine(s);
  el.stateLine.classList.toggle('good', s.status === 'won');
  syncKeypad();
}

const KIND_NAME = { level: '出厂关卡', tier: '现场出题', daily: '日课' };

// The sentence the player gets is the one the engine wrote: `dead` is deadEnd()'s own words about
// this ink, and the rest are counts the same diagnose() pass produced. Nothing here diagnoses.
function stateLine(s) {
  if (s.status === 'won') return '每一条边的读数都对上了。';
  if (s.dead) return `这堆墨已经推不完了：${s.dead} 撤销一步再想。`;
  if (s.conflicts) return `${s.conflicts} 条边和现在写下的数对不上——重复的高度，或者一眼望进去比印出来的多。`;
  if (s.badCells) return `${s.badCells} 格里的高度在同一行/列里出现了两次。`;
  if (s.noteErrors) return `${s.noteErrors} 处候选已经被线索排除了，可以抹掉。`;
  return '';
}

function syncAll() {
  syncStats();
  draw();
}

function flushResume() {
  if (!game || game.status === 'won') return;
  Store.saveResume(game.puzzle, game.st, clock(), { moves: game.moves, hints: game.hints });
}

function startClock() {
  paused = false;   // 新一局从"没暂停"开始；setPaused(false) 走的就是这条路
  startedAt = Date.now();
  clearInterval(ticker);
  ticker = setInterval(() => {
    el.time.textContent = fmtMs(clock());
    if (pulse) draw();
  }, 1000);
}

function stopClock() {
  baseElapsed = clock();
  sim.runSeconds = 0;
  clockRunning = false;
}

// ---- the keypad and the two pen modes ----------------------------------------------------------

// The keypad is built from the board's own 1..n, so a 4×4 never offers a height that cannot exist.
function buildKeypad() {
  const n = game ? game.w : 0;
  el.keypad.innerHTML = '';
  for (let v = 1; v <= n; v++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.digit = String(v);
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `${v}${v === n ? '<small>最高</small>' : v === 1 ? '<small>最矮</small>' : '<small>&nbsp;</small>'}`;
    b.addEventListener('click', () => pressDigit(v));
    el.keypad.appendChild(b);
  }
}

function syncKeypad() {
  if (!game) return;
  for (const b of el.keypad.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.digit) === game.digit));
  }
  el.keypad.hidden = false;
}

function setMode(value) {
  if (blocked() || !game) return value;
  game.mode = value;
  $('#btn-mode-ink').setAttribute('aria-pressed', String(value === INK));
  $('#btn-mode-note').setAttribute('aria-pressed', String(value === NOTE));
  el.canvas.dataset.mode = value === NOTE ? 'note' : 'ink';
  draw();
  return value;
}

function setDigit(v) {
  if (!game) return false;
  const ok = game.setDigit(v);
  syncKeypad();
  return ok;
}

// A keypad press is one gesture and therefore one undo step, whichever pen is up. In 候选 mode it
// marks the selected cell; in 数字 mode it writes the height exactly — which is what makes the
// cycle-on-tap shortcut and the exact-write shortcut coexist.
function pressDigit(v) {
  if (blocked() || !game || game.status === 'won') return null;
  setDigit(v);
  const cell = game.selected;
  if (cell < 0) return null;
  return settle(game.mode === NOTE ? game.toggleNote(cell, v) : game.put(cell, v));
}

function eraseCell() {
  if (blocked() || !game || game.status === 'won' || game.selected < 0) return null;
  return settle(game.put(game.selected, EMPTY));
}

function wipeNotes() {
  if (blocked() || !game) return null;
  return settle(game.wipeNotes());
}

function undo() {
  if (blocked() || !game) return null;
  const step = game.undo();
  if (!step) return null;
  clearPulse();
  Sound.undo();
  syncAll();
  flushResume();
  return step;
}

// A gesture's whole aftermath, in one place: repaint, then either record the win or bank the run.
// The sound follows the step the engine actually took, so an aborted gesture stays silent rather
// than confirming a write that never happened.
function settle(step) {
  syncAll();
  if (!game) return null;
  if (game.status === 'won') {
    onWin();
    return step;
  }
  if (step) {
    const kind = step.kind;
    const v = step.value;
    if (kind === 'note') Sound.note();
    else if (kind === 'wipe') Sound.erase();
    else if (v === EMPTY) Sound.erase();
    else Sound.place(v, game.w);
    if (game.diag.violated.size || game.dead) Sound.conflict();
  }
  flushResume();
  return step;
}

function useHint() {
  if (blocked() || !game || game.status === 'won') return null;
  const info = game.hint();
  if (!info) return null;
  // Whether this hint cost anything is the engine's business: game.hint() only calls commit() for a
  // row it actually wrote or struck, so this file never has to decide what counts as help.
  showHint(info);
  syncAll();
  if (game.status === 'won') onWin();
  else flushResume();
  return info;
}

function clearPulse() {
  pulse = null;
  sim.pulseAge = 0;
  sim.pulsePhase = 0;
  sim.pulseScale = 1;
  dirty = true;
}

function showHint(info) {
  if (info.stalled) {
    el.hintRule.textContent = '线索推到头了';
    el.hintLine.textContent = info.text;
    return;
  }
  if (info.conflict) {
    el.hintRule.textContent = '这条线索和你的墨冲突';
    el.hintLine.textContent = info.conflict;
    pulse = { cell: info.cell, color: Palette.error };
    Sound.conflict();
    beginPulse();
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}（第 ${info.level} 层）`;
  el.hintLine.textContent = info.why;
  pulse = { cell: info.cell, clueIdx: info.clueIdx };
  if (info.charged) Sound.hint();
  beginPulse();
}

// Re-arms the ring's virtual timer. The loop's stepSim() is what ages it out, so the ring holds
// for exactly PULSE_S virtual seconds at any refresh rate — and freezes while paused.
function beginPulse() {
  sim.pulseAge = 0;
  sim.pulsePhase = 0;
  sim.pulseScale = 1;
  dirty = true;
}

// ---- win / records -----------------------------------------------------------------------------

function onWin() {
  stopClock();
  const ms = clock();
  const p = game.puzzle;
  const better = Store.recordBest(p.tier, { ms, hints: game.hints, moves: game.moves, size: `${game.w}×${game.h}` });
  Store.recordSolve(ms, game.hints);
  if (p.kind === 'level' && p.levelId) Store.clearLevel(p.levelId, { ms, hints: game.hints, moves: game.moves });
  if (p.kind === 'daily' && p.dateKey) Store.markDaily(p.dateKey, { ms, hints: game.hints, moves: game.moves });
  Store.clearResume();
  el.winMeta.textContent = `${tierFor(p.tier).name} · ${game.w}×${game.h} · ${KIND_NAME[p.kind] || p.kind} · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次`;
  el.winRecord.textContent = better
    ? '新纪录：这一局比存档里的更不求人。'
    : '未破纪录：同档先比提示次数，再比步数，最后才比时间。';
  el.winVeil.hidden = false;
  syncAll();
  Sound.win();
  renderRecords();
  renderChapters();
  renderDailyCard();
  renderResumeCard();
}

// ---- pause / restart / fullscreen --------------------------------------------------------------

// The one string the harness and the frame probe read to know where the player actually is.
function phaseName() {
  if (shown !== 'game') return 'menu';
  if (paused) return 'paused';
  if (game && game.status === 'won') return 'won';
  return 'playing';
}

// Nothing that changes the ink is allowed through while paused or outside a board. The veil covers
// the canvas, but the keyboard, the panel buttons and `window.skyscraper` all reach these functions
// directly — so the refusal lives here, once, rather than in CSS.
const blocked = () => paused || shown !== 'game';

// Pausing is not an overlay painted over a live board: the run's clock stops, the hint ring's
// breath stops, the audio context is put to sleep, and every gesture that could move ink is
// refused. Resuming hands back the same board, the same marks and the same elapsed time — nothing
// is re-derived, and nothing is re-timed.

function syncPauseButton() {
  const b = el.btnPause;
  if (!b) return;
  const glyph = b.querySelector('.hud-glyph');
  if (glyph) glyph.textContent = paused ? '▶' : '❙❙';
  b.setAttribute('aria-pressed', String(paused));
  b.classList.toggle('on', paused);
  b.setAttribute('aria-label', paused ? '继续这一局（P）' : '暂停这一局（P）');
}

// 重来这局. It re-enters through openPuzzle() with the *same* puzzle, which is what makes it a
// reset rather than a wipe: openPuzzle builds a fresh Game (engine ink, pencil marks, the undo
// stack, the hint cursor and the move/hint counters all reconstructed from the puzzle), clears the
// pulse and the in-flight stroke, zeroes the banked elapsed and the run's virtual seconds, hides
// both veils, rebuilds the keypad for this board's 1..n, and re-arms the clock.
function restartRun() {
  if (!game) return null;
  const puzzle = game.puzzle;
  setPaused(false);
  return openPuzzle(puzzle);
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

// Bound to a button that exists in the HUD (#btn-fullscreen) and to the F key. On iOS the request
// only survives inside a user activation, so a keyboard-only path would be a promise the platform
// does not keep; and the webkit prefix is not decoration — without it an iPad answers nothing.
function toggleFullscreen() {
  if (fullscreenElement()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) Promise.resolve(exit.call(document)).catch(() => {});
    return false;
  }
  const node = el.app || document.documentElement;
  const req = node.requestFullscreen || node.webkitRequestFullscreen || node.webkitRequestFullScreen;
  if (!req) return false;
  Promise.resolve(req.call(node, { navigationUI: 'hide' })).catch(() => {});
  return true;
}

function syncFullscreen() {
  const on = !!fullscreenElement();
  const b = el.btnFullscreen;
  if (b) {
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('on', on);
    b.setAttribute('aria-label', on ? '退出全屏（F）' : '全屏（F）');
  }
  document.body.classList.toggle('fullscreen', on);
  // The board is sized from #board-wrap's content box, and fullscreen changes that box without
  // always firing a resize.
  draw();
  return on;
}

// The game's own teaching surface: the hint panel already says what a clue claims and what a rule
// proved, so the key map is written there rather than into a modal nobody reads.
const CONTROL_LINES = [
  '点击/触摸 换数 · 拖动 用键盘上的数一笔抹过去 · 点边上的数 问它说了什么',
  '1..n 选高度 · 回车/空格 写进选中格 · 方向键 移动选中格 · X 清除 · W 抹候选 · N 换候选模式',
  'H 提示 · Z 撤销 · P 暂停 · R 重来这局 · M 静音 · F 全屏 · Esc 回选关',
];
let controlAt = -1;
function showControls() {
  controlAt = (controlAt + 1) % CONTROL_LINES.length;
  el.hintRule.textContent = `玩法与键位 ${controlAt + 1}/${CONTROL_LINES.length}`;
  el.hintLine.textContent = CONTROL_LINES[controlAt];
  return CONTROL_LINES[controlAt];
}

// ---- opening a board ---------------------------------------------------------------------------

// `resume` is the already-sanitised save from Store.resume(); it is applied only to a board that
// rebuilds to the same size, so a save can never be painted onto a shifted picture.
function openPuzzle(puzzle, resume = null) {
  if (!puzzle) return null;
  game = new Game(puzzle);
  paused = false;
  Sound.setHeld(false);
  clearPulse();
  stroke = null;
  el.winVeil.hidden = true;
  el.pauseVeil.hidden = true;
  syncPauseButton();
  baseElapsed = 0;
  sim.runSeconds = 0;
  if (resume && resume.cells === puzzle.n * puzzle.n) {
    game.load(resume.ink, resume.notes);
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
    game.cursor = 0;
    baseElapsed = resume.elapsedMs || 0;
  }
  // `show` first, then the mode: setMode() refuses to run while the board is not on screen (see
  // blocked()), so opening a board had to enter the view before it could raise a pen.
  buildKeypad();
  show('game');
  setMode(INK);
  game.select(0);
  startClock();
  el.hintRule.textContent = '提示理由';
  el.hintLine.innerHTML = '按 <b>提示</b>：说下一条线索逼得出的事实，以及它依据哪条边的哪个数。';
  syncAll();
  flushResume();
  renderResumeCard();
  if (game.status === 'won') onWin();
  return game;
}

// 重开：**同一道题**从头再来 —— 落笔、便签、撤销栈、步数、提示次数、提示游标、计时、
// 结算遮罩全部归零，但不换题。跟「换一局 / 换关卡」的分工：那些是去开一道新题
//（本仓的 begin() 走 openTier/openLevel/openDaily，那几条路都会重抽题面），
// 这里是"这题我走错了，原地重来"——玩家要的是同一个题。
//
// **特意不走 begin()/openPuzzle()**：那两条路的第一件事就是 new Game(puzzle)，
// 等于把题也换了，那就不是重开而是换题。复位只允许动这一局的痕迹。
// 为什么不能只调一次 resetInk() 就完事：那一步只碰得到引擎的盘面与 history，
// UI 层的撤销栈、步数、提示次数、提示游标、键盘选中的格与数字都是各自独立存着的缓存
// （详见 Game.resetAll 的注释）。
function restart() {
  if (!game) return null;
  game.resetAll();            // 盘面 + steps + moves + hints + cursor + status + mode + digit + selected
  clearPulse();               // 上一条提示留下的高亮，属于上一局
  stroke = null;              // 上一次没画完的拖拽手势
  el.winVeil.hidden = true;   // 结算遮罩收起：上一局赢了的遮罩不能压在重开后的盘上
  baseElapsed = 0;            // 耗时归零
  // 暂停中重开就保持停表，否则 startClock() 会把暂停期间憋下的墙钟一次性灌进计时。
  if (paused) {
    startedAt = 0;
    clearInterval(ticker);
    ticker = 0;
  } else {
    startClock();             // 没暂停就重新起跑，重开后的计时是这一局自己的
  }
  buildKeypad();              // 键盘面板跟着新的数字范围重建（1..n 随题面走）
  setMode(INK);               // 临时态：落笔模式回默认，HUD 的 aria-pressed 一起回写
  game.select(0);             // 键盘选中的格回第一格
  show('game');
  el.hintRule.textContent = '提示理由';
  el.hintLine.innerHTML = '按 <b>提示</b>：说下一条线索逼得出的事实，以及它依据哪条边的哪个数。';
  syncAll();
  // 存档覆盖成本局的空盘：刷新页面不会又冒出走错那半局的线。
  // 特意**不**碰 Store 的偏好（静音 / 减动效 / 最好成绩）——那是玩家的东西，不是这一局的东西。
  flushResume();
  renderResumeCard();
  return game;
}

function openTier(tierKey, seed = null) {
  const key = TIERS.some((t) => t.key === tierKey) ? tierKey : TIERS[0].key;
  return openPuzzle(seed ? puzzleFromTier(key, seed) : openingFor(key));
}

function openLevel(id) {
  const row = levelById(id);
  return row ? openPuzzle(puzzleFromLevel(row)) : null;
}

function openDaily() {
  return openPuzzle(dailyBoard());
}

// The one entry point the harness and the buttons share. `level` wins over `tier`, and a save is
// rebuilt from (kind, tier/levelId/dateKey, seed) — the same triple the archive holds.
function begin({ tier = null, seed = null, level = null, daily = false, resume = null } = {}) {
  if (resume) {
    const p =
      resume.kind === 'level' && resume.levelId
        ? levelById(resume.levelId) && puzzleFromLevel(levelById(resume.levelId))
        : resume.kind === 'daily'
          ? rebuildDaily(resume)
          : puzzleFromTier(resume.tier, resume.seed);
    if (!p) return null;
    if (tier && p.tier !== tier) return null;
    return openPuzzle(p, resume);
  }
  if (daily) return openDaily();
  if (level) return openLevel(level);
  return openTier(tier || (game ? game.puzzle.tier : TIERS[0].key), seed);
}

// manifest.webmanifest 的两条 shortcuts 承诺了 ./?daily=1 与 ./?resume=1。清单既然把话说了出去，
// 落地页就得真的走到那一张盘 —— 否则快捷方式只是盘上的装饰，正是这一轮要防的"说了没做"。
// 走的是按钮同一个 begin()，所以从主屏图标进来和从菜单点进去不是两条代码路径。
function applyDeepLink() {
  const q = new URLSearchParams(location.search || '');
  if (q.get('daily') === '1') return begin({ daily: true }) ? 'daily' : '';
  if (q.get('resume') === '1') {
    const r = Store.resume();
    return r && r.seed && begin({ resume: r }) ? 'resume' : '';
  }
  return '';
}

// A daily save belongs to its date: if the calendar rolled over while the tab was closed, the ink on
// it is yesterday's answer to today's board, so the card offers nothing rather than a false resume.
function rebuildDaily(resume) {
  const p = dailyBoard();
  if (!p || !resume.dateKey || resume.dateKey !== p.dateKey) return null;
  return p;
}

// ---- views -------------------------------------------------------------------------------------

function show(which) {
  shown = which === 'game' ? 'game' : 'menu';
  el.viewMenu.hidden = shown !== 'menu';
  el.viewGame.hidden = shown !== 'game';
  if (shown === 'menu') {
    // A pause belongs to a board. Leaving for the menu folds the frozen seconds into the archive
    // and takes the veil down, so 继续 rebuilds from a save rather than from a suspended state.
    if (paused) setPaused(false);
    stopClock();
    Sound.setHeld(false);
    renderMenu();
  }
  if (shown === 'game') draw();
  return shown;
}

function renderMenu() {
  renderChapters();
  renderTiers();
  renderRecords();
  renderRules();
  renderResumeCard();
  renderDailyCard();
  renderProof();
}

function renderChapters() {
  el.chapters.innerHTML = '';
  el.clearedCount.textContent = Store.clearedCount();
  for (const ch of CHAPTERS) {
    const box = document.createElement('div');
    const unlocked = chapterUnlocked(ch.index);
    box.className = `chapter${unlocked ? '' : ' locked'}`;
    const prog = chapterProgress(ch.index);
    const head = document.createElement('div');
    head.className = 'chapter-head';
    head.innerHTML =
      `<span class="chapter-name">${ch.index + 1} · ${ch.name}</span>` +
      `<span class="chapter-meta">${ch.n}×${ch.n} · ${prog.done}/${prog.total} · 实测 ${ch.band[0]}–${ch.band[1]}</span>`;
    box.appendChild(head);
    const blurb = document.createElement('p');
    blurb.className = 'chapter-blurb';
    blurb.textContent = unlocked ? ch.blurb : '前一档过关之后解锁。';
    box.appendChild(blurb);
    const grid = document.createElement('div');
    grid.className = 'levels';
    ch.levels.forEach((row, j) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = Store.levelCleared(row.id) ? 'done' : '';
      b.disabled = !unlocked;
      b.title = `${row.name} · ${row.clues} 条线索 · ${row.steps} 步推到底 · 最常用「${row.topRule}」`;
      b.textContent = String(j + 1);
      b.addEventListener('click', () => openLevel(row.id));
      grid.appendChild(b);
    });
    box.appendChild(grid);
    el.chapters.appendChild(box);
  }
}

const TIER_NOTE = {
  novice: '四条边几乎写满，一眼能看见的数直接给出格子',
  casual: '边上的数少了，得开始问「这一行的摆法还剩几种」',
  regular: '五阶，最高楼能站的位置要两头一起算',
  sharp: '五阶，线索稀到只剩整行排列集推得动',
  master: '六阶，几格候选挤在同样几格里，Hall 家族才解得开',
};

function renderTiers() {
  el.tiers.innerHTML = '';
  TIERS.forEach((t, i) => {
    const meta = TIERS_META[t.key] || {};
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = t.key;
    b.innerHTML =
      `<span class="tier-name">${i + 1} · ${t.name}</span>` +
      `<span class="tier-note">${TIER_NOTE[t.key] || ''}</span>` +
      `<span class="tier-size mono">${t.n}×${t.n} · 实测 ${t.band[0]}–${t.band[1]}${meta.levels ? ` · 出厂 ${meta.levels} 关` : ''}</span>`;
    b.addEventListener('click', () => openTier(t.key));
    el.tiers.appendChild(b);
  });
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const t of TIERS) {
    const li = document.createElement('li');
    const best = Store.best(t.key);
    li.dataset.tier = t.key;
    li.innerHTML =
      `<b>${t.name}</b>` +
      (best
        ? `<span class="mono">${fmtMs(best.ms)}</span> · 提示 ${best.hints} · ${best.moves} 步<br><span>${best.size || `${t.n}×${t.n}`}</span>`
        : '<span>还没有纪录</span>');
    el.records.appendChild(li);
  }
}

// The rule list is printed off the engine's own table, so the menu cannot advertise a rule the
// hints never cite — and the 提示 panel's 「规则：X」 line always has an entry here to match it.
//
// Each entry also carries how often it actually fires on the 20 shipped levels, counted here in the
// browser by running the same solve() the generator used. That number is the difference between a
// caption and a census: three of these thirteen never fire on the factory boards (they exist for
// boards whose clues are sparser), and the menu says so rather than letting the list look like a
// menu of tricks every board needs.
let census = null;
function ruleCensus() {
  if (census) return census;
  const fired = {};
  for (const row of LEVELS) {
    const s = Engine.solve(boardOfRow(row));
    for (const [name, n] of Object.entries(Engine.rulesUsed(s.rows))) fired[name] = (fired[name] || 0) + n;
  }
  census = fired;
  return fired;
}

function renderRules() {
  const fired = ruleCensus();
  el.ruleList.innerHTML = '';
  const list = [...Engine.RULE_LIST].sort((a, b) => a.level - b.level || a.weight - b.weight);
  for (const r of list) {
    const li = document.createElement('li');
    const n = fired[r.name] || 0;
    li.innerHTML =
      `<b>${r.name}</b> <span class="lv">第 ${r.level} 层 · 权重 ${r.weight} · 出厂关卡里开火 ${n} 次${n ? '' : '（沉默）'}</span>`;
    el.ruleList.appendChild(li);
  }
  const lv = new Set(list.map((r) => r.level));
  const silent = list.filter((r) => !fired[r.name]).length;
  el.ruleTitle.textContent =
    `铅笔路径的规则表 · ${list.length} 条、分 ${lv.size} 层，出厂关卡现场数出来：${silent} 条在这 20 关里一次也没开火`;
}

function renderProof() {
  const totals = PROOF.totals || {};
  el.proofNote.innerHTML =
    `上面这些数字不是抄自说明文件：<code>npm run bake -- --check</code> 会拿每一关的线索串把分数、步数、` +
    `线索数、深度逐格重算一遍，对不上就红。出厂的 <b>${totals.levels || 0}</b> 关各由三套互不信任的实现看过：` +
    `铅笔路径推到底 <b>${totals.finished || 0}</b>、逐格穷举判唯一 <b>${totals.unique || 0}</b>、` +
    `朴素拉丁方枚举同判 <b>${totals.naiveAgree || 0}</b>。`;
  const m = PROOF.math || {};
  el.proofLine.textContent =
    `${totals.levels || 0} 关 · 唯一解 ${totals.unique || 0}/${totals.levels || 0} · 推到底 ${totals.finished || 0}/${totals.levels || 0}` +
    ` · 可见数分布 = 第一类 Stirling 数 · 拉丁方 ${JSON.stringify(m.latin || {})}`;
}

function renderResumeCard() {
  const r = Store.resume();
  const live = game && game.status !== 'won' && running();
  if (!r || !r.seed || (live && r.seed === (game.puzzle.originSeed || game.puzzle.seed) && r.tier === game.puzzle.tier)) {
    el.resumeCard.hidden = true;
    return null;
  }
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `继续 ${tierFor(r.tier).name} 的一局（${KIND_NAME[r.kind] || r.kind}）`;
  el.resumeMeta.textContent = `${fmtMs(r.elapsedMs || 0)} · ${r.moves || 0} 步 · 提示 ${r.hints || 0} 次 · ${r.cells} 格`;
  return r;
}

function renderDailyCard() {
  const p = dailyBoard();
  if (!p) {
    el.dailyMeta.textContent = '今日这一档的题没造出来（生成器会如实报失败，不会换一张软的）';
    $('#btn-daily').disabled = true;
    return;
  }
  $('#btn-daily').disabled = false;
  el.dailyMeta.textContent = `${p.dateKey} · ${p.tierName} · ${p.n}×${p.n} · 实测 ${Number(p.score).toFixed(1)}`;
  $('#btn-daily').textContent = Store.dailyDone(p.dateKey) ? '重做' : '今日';
}

function applySettings() {
  // `sound` is the stored setting and `muted` is its exact complement — one fact, two spellings,
  // so an archive written before the mute switch existed still means the same thing.
  Sound.setMuted(!Store.setting('sound'));
  const reduce = !!Store.setting('reduceMotion') || systemPrefersReducedMotion();
  setReduceMotion(!!Store.setting('reduceMotion'));
  document.body.classList.toggle('reduce-motion', reduce);
  const btn = $('#btn-sound');
  btn.setAttribute('aria-pressed', String(!Sound.muted()));
  btn.textContent = Sound.muted() ? '音效 关' : '音效 开';
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  $('#btn-motion').textContent = reduce ? '动效 省' : '动效 全';
}

// ---- pointer gestures --------------------------------------------------------
// A press that stays on one cell is a tap: 数字 mode walks it round 空→1→…→n→空. A press that
// travels is one stroke that paints the keypad's current height across every cell it entered. Both
// consume exactly one engine snapshot, so 撤销 takes back what the player thinks they did.
// In 候选 mode a drag paints nothing: toggling a pencil mark is a per-cell decision, and making one
// swipe flip six of them would break the same one-gesture-one-undo rule rather than keep it.
function preview(i, value) {
  stroke.items.push({ cell: i, from: game.st.cell[i] });
  game.st.cell[i] = value;
  game.recompute();
}

function unpreview(s = stroke) {
  for (const it of s.items) game.st.cell[it.cell] = it.from;
  game.recompute();
}

function pointerDown(ev) {
  if (blocked() || !game || game.status === 'won') return;
  const clue = view.clueAt(ev.clientX, ev.clientY);
  if (clue) {
    // Tapping a printed count says what that count is a claim about — read off the board, not
    // composed here.
    const i = Engine.clueIndex(game.w, clue.side, clue.k);
    const v = game.board.clue[i];
    clearPulse();
    if (v === Engine.NO_CLUE) {
      el.hintRule.textContent = '这条边没有印数';
      el.hintLine.textContent = `${game.board.clueName(i)}：这里什么都没说，别把它当成 0。`;
    } else {
      const track = game.board.tracks.find((t) => t.idxA === i || t.idxB === i);
      el.hintRule.textContent = `边上的数：${game.board.clueName(i)}＝${v}`;
      el.hintLine.textContent = `从这一边望进 ${track ? game.board.trackName(track.id) : '这条线'}，看得见 ${v} 栋楼——${v === 1 ? '第一格就是最高那栋' : v === game.w ? '这一眼必须一路升高' : '中间的格得对得上这一眼能数出几栋'}。`;
    }
    pulse = { clueIdx: i };
    beginPulse();
    draw();
    return;
  }
  const i = view.hitCell(ev.clientX, ev.clientY);
  if (i < 0) return;
  ev.preventDefault();
  el.canvas.setPointerCapture?.(ev.pointerId);
  clearPulse();
  game.select(i);
  const note = game.mode === NOTE;
  stroke = { items: [], value: game.digit, anchor: i, moved: false, note };
  if (!note) preview(i, game.digit);
  draw();
}

function pointerMove(ev) {
  if (!stroke || !game) return;
  const i = view.hitCell(ev.clientX, ev.clientY);
  if (i < 0 || i === stroke.anchor || stroke.items.some((s) => s.cell === i)) return;
  stroke.moved = true;
  if (stroke.note) {
    draw();
    return;
  }
  preview(i, stroke.value);
  draw();
}

function pointerUp() {
  if (paused) { stroke = null; return null; }
  if (!stroke || !game) return null;
  const s = stroke;
  stroke = null;
  const anchor = s.anchor;
  // `s` explicitly: unpreview()'s default argument is the module-level `stroke`, which was just set
  // to null so a second release cannot start a second stroke. Left to that default the loop reads
  // `null.items` and throws — which takes the whole gesture down with it, so no tap on the board
  // would ever commit. Only a real pointer event reaches this line; a scripted tap through the
  // facade does not, which is why it survives every non-browser gate.
  unpreview(s);
  if (s.note || !s.moved) {
    const step = s.note ? game.toggleNote(anchor, game.digit) : game.tap(anchor, INK);
    return settle(step);
  }
  const cells = s.items.map((it) => it.cell);
  return settle(game.stroke(cells, s.value));
}

el.canvas.addEventListener('pointerdown', pointerDown);
el.canvas.addEventListener('pointermove', pointerMove);
el.canvas.addEventListener('pointerup', pointerUp);
el.canvas.addEventListener('pointercancel', () => {
  if (!stroke) return;
  unpreview();
  stroke = null;
  syncAll();
});
el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

$('#btn-mode-ink').addEventListener('click', () => setMode(INK));
$('#btn-mode-note').addEventListener('click', () => setMode(NOTE));
$('#btn-erase').addEventListener('click', eraseCell);
$('#btn-wipe').addEventListener('click', wipeNotes);
$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-restart').addEventListener('click', restart);
$('#btn-new').addEventListener('click', () => openTier(game ? game.puzzle.tier : TIERS[0].key));
$('#btn-menu').addEventListener('click', () => {
  flushResume();
  show('menu');
});
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-again').addEventListener('click', () => {
  const p = game.puzzle;
  if (p.kind === 'level') {
    const ch = CHAPTERS.find((c) => c.levels.some((l) => l.id === p.levelId));
    const next = ch && ch.levels[ch.levels.findIndex((l) => l.id === p.levelId) + 1];
    if (next && chapterUnlocked(ch.index)) return openLevel(next.id);
  }
  openTier(p.tier);
});
$('#btn-daily').addEventListener('click', openDaily);
$('#btn-pause').addEventListener('click', () => setPaused(!paused));
$('#btn-restart').addEventListener('click', restartRun);
$('#btn-fullscreen').addEventListener('click', toggleFullscreen);
$('#btn-resume-play').addEventListener('click', () => setPaused(false));
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume();
  // No origin seed means no way to rebuild *that* board: the generator is deterministic in its seed,
  // so resuming without one would paint old ink onto a different puzzle.
  if (!r || !r.seed) return null;
  return begin({ resume: r });
});
// One place flips the switch, so the button, the M key and the harness cannot drift apart.
function toggleMute() {
  Store.setSetting('sound', Sound.muted());
  applySettings();
  // The confirmation blip is after the switch moved, and applySettings has already re-opened the
  // gate — so it is audible exactly when the player has just asked for sound.
  if (!Sound.muted()) Sound.note();
  return Sound.muted();
}
$('#btn-sound').addEventListener('click', toggleMute);
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  show('menu');
});

// Digits mean different things per view: in the menu they pick a rung, on a board they pick a height.
window.addEventListener('keydown', (ev) => {
  if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
  const k = ev.key;
  const lower0 = k.toLowerCase();
  // M and F mean the same thing on either view — they are about the room, not the board.
  if (lower0 === 'm') {
    toggleMute();
    return;
  }
  if (lower0 === 'f') {
    toggleFullscreen();
    return;
  }
  if (shown === 'menu') {
    if (/^[1-5]$/.test(k)) openTier(TIERS[Number(k) - 1].key);
    else if (k === 'Enter' || k === ' ') {
      // 回车/空格 开局：whatever the resume card is offering first, else the rung the player last
      // stood on, else the factory rung. A dead Enter is the thing that makes a keyboard-only
      // player conclude the page is broken.
      const r = Store.resume();
      if (r && r.seed) begin({ resume: r });
      else openTier(game ? game.puzzle.tier : TIERS[0].key);
    } else if (k === '?') renderMenu();
    return;
  }
  if (k === 'Escape') {
    flushResume();
    show('menu');
    return;
  }
  // Space and the arrows are page-scroll keys in the browser's hands first; on a board they mean
  // 写这一格 and 换一格.
  if (k === ' ' || k.startsWith('Arrow')) ev.preventDefault();
  const lower = k.toLowerCase();
  // While paused the board refuses ink, but the controls that end the pause — or that are about
  // the room rather than the run — still answer.
  if (lower === 'p') {
    setPaused(!paused);
    return;
  }
  if (lower === 'r') {
    restartRun();
    return;
  }
  if (k === '?') {
    showControls();
    return;
  }
  if (paused) return;
  if (lower === 'h') useHint();
  else if (lower === 'z') undo();
  else if (lower === 'n') setMode(game.mode === INK ? NOTE : INK);
  else if (lower === 'x') eraseCell();
  else if (lower === 'w') wipeNotes();
  // R 重开同一题，**局中就能按**（不只结算后）：玩家填到一半发现这条边数错了，当场 R 一下。
  // 本仓原先没有任何键占着 R（h/z 是玩法，n 切笔注，x 擦，w 清便签，数字键选数），不需要换键。
  else if (lower === 'r') restart();
  else if (k === 'Enter' || k === ' ') pressDigit(game.digit);
  else if (/^[1-9]$/.test(k)) {
    const v = Number(k);
    if (v <= game.w) setDigit(v);
  } else if (k.startsWith('Arrow')) moveSelection(k);
});

// Keyboard selection, so the board is reachable without a pointer: the ring the tap walks is
// useless if the cell under the arrow keys is not the one 回车 writes into.
function moveSelection(k) {
  if (!game) return;
  const n = game.w;
  let i = game.selected;
  if (i < 0) i = 0;
  else if (k === 'ArrowLeft') i = i % n ? i - 1 : i;
  else if (k === 'ArrowRight') i = i % n < n - 1 ? i + 1 : i;
  else if (k === 'ArrowUp') i = i >= n ? i - n : i;
  else if (k === 'ArrowDown') i = i + n < n * n ? i + n : i;
  game.select(i);
  syncAll();
}

window.addEventListener('resize', draw);
['fullscreenchange', 'webkitfullscreenchange'].forEach((type) =>
  document.addEventListener(type, syncFullscreen),
);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushResume();
    // A hidden tab stops painting, so the loop's dt would come back as one huge frame. Pausing on
    // hide is what keeps the run's clock meaning "time looked at" instead of "time the tab lived".
    if (shown === 'game' && !paused) setPaused(true);
    Sound.setHeld(true);
  } else {
    Sound.setHeld(paused);
    // Do not resume the run, but do drop the stale frame boundary, or the first visible frame
    // reports the whole hidden stretch as its dt.
    lastFrameAt = 0;
  }
});
window.addEventListener('pagehide', flushResume);

// js/theme.js owns the touch floor as Cell.minTouch; the stylesheet needs it as a custom property,
// so it is handed over here rather than written a second time in CSS.
document.documentElement.style.setProperty('--touch-min', `${Cell.minTouch}px`);
applyThemeVars();
applySettings();
renderMenu();
syncPauseButton();
const deepLink = applyDeepLink();
startLoop();

const surface = {
  version: VERSION,
  view,
  // 重开同一题：挂在窗口上是为了让探针能真的驱动一次、读 BEFORE/AFTER，
  // 而不必去合成点击（键盘面板的点击在离屏环境里不稳）。
  restart,
  get game() {
    return game;
  },
  shown: () => shown,
  phase: phaseName,
  // Which manifest shortcut (if any) actually landed on a board: '' means the query was decoration.
  deepLink: () => deepLink,
  // The loop's own numbers. A harness feeds update() a virtual clock and reads these back; that is
  // the only way "frame-rate independent" can be settled with digits instead of adjectives.
  sim,
  update,
  stepSim,
  paused: () => paused,
  setPaused,
  restartRun,
  toggleFullscreen,
  toggleMute,
  muted: () => Sound.muted(),
  showControls,
  show,
  begin,
  openTier,
  openLevel,
  openDaily,
  useHint,
  undo,
  setMode,
  setDigit,
  pressDigit,
  eraseCell,
  wipeNotes,
  mode: { INK, NOTE },
  // The harness commits through the same paths a pointer release does, so a scenario that passes
  // here has driven the real state machine rather than a copy of it. These three are that same
  // door from the outside, so they honour the same `blocked()` the keys and the pointer honour:
  // a paused or won board refuses input through *every* handle, not just the visible ones.
  tap(i, value) {
    if (blocked() || !game) return null;
    return settle(value === undefined ? game.tap(i, game.mode) : game.put(i, value));
  },
  stroke(cells, value) {
    if (blocked() || !game) return null;
    return settle(game.stroke(cells, value === undefined ? game.digit : value));
  },
  select(i) {
    if (blocked() || !game) return -1;
    const r = game.select(i);
    draw();
    return r;
  },
  solveWithLogic({ cap = 6000 } = {}) {
    if (blocked() || !game) return null;
    const r = game.solveWithLogic({ cap });
    syncAll();
    if (game.status === 'won') onWin();
    return r;
  },
  elapsed: clock,
  voices: () => Sound.voices(),
  state: () => (game ? { ...game.state(), elapsedMs: clock(), dead: game.dead, persistent: Store.persistent } : null),
  cellAt: (x, y) => (game ? game.cellAt(x, y) : -1),
  valueOf: (i) => (game ? game.valueOf(i) : EMPTY),
  noteOf: (i) => (game ? game.notesOf(i) : 0),
  clueOf: (i) => (game ? game.board.clue[i] : Engine.NO_CLUE),
  // Where the canvas put the grid last time it painted: a harness that wants to send a real pointer
  // event to cell (x, y) has to aim with the same numbers hitCell() answered with.
  geo: () => view.geo,
  engine: {
    ...Engine,
    Game,
    BoardView,
    Store,
    Sound,
    TIERS,
    tierFor,
    LEVELS,
    PROOF,
    TIERS_META,
    CHAPTERS,
    chapterUnlocked,
    chapterProgress,
    levelById,
    puzzleFromLevel,
    puzzleFromTier,
    dailyPuzzle,
    dateSeed,
    openingFor,
    INK,
    NOTE,
    EMPTY,
  },
};

// Two names for one object. `window.skyscraper` is this game's namespace (the sibling repos in the
// family use `window.<slug>` and next round's verification台 drives that one); `window.App` is the
// game-agnostic handle a generic driver can grab without knowing the slug.
window.skyscraper = surface;
window.App = surface;

// ---- 全屏开关（#btn-fullscreen）----
// 绑的是本页 HUD 上真实存在的那个按钮。全屏最常见的假实现就是引用一个并不存在的
// id：点下去什么也不会发生，量具却算它"已实现"。所以这里找不到按钮就直接不装。
(function bindFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const root = document.documentElement;
  // 只做特性检测，不嗅探 UA：iOS Safari 是 webkitRequestFullscreen，老 Edge 是 ms 前缀，
  // 而 UA 字符串随时会改。"有没有这个能力"是查出来的，不是猜出来的。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;

  // 不支持也要给个说法：只把按钮灰掉而不解释，玩家会以为这功能没做完。
  // supported 这枚标记不能省：下面 sync() 每次都会重写 title，不挡住的话，装的时候刚写
  // 进去的人话原因会被随后的 sync() 立刻抹成"全屏 (F)"——禁用就变成一句没有理由的禁用。
  let supported = !!req;
  const unsupported = () => {
    supported = false;
    btn.disabled = true;
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」独立打开）';
  };
  if (!req) unsupported();

  // fullscreen 返回 Promise，被拒时必须吃掉：iOS Safari 对多数非 video 元素直接拒绝，
  // 让这个 rejection 冒泡出去会变成一条未捕获错误，整局游戏跟着挂。
  const settle = (p) => { if (p && p.catch) p.catch(unsupported); };

  // 进出都能走：已经全屏时这次调用是退出，不是"再进一次"。
  function toggle() {
    try {
      if (current()) {
        if (exit) settle(exit.call(document));
      } else if (req) {
        settle(req.call(root));
      } else {
        unsupported();
      }
    } catch (e) {
      unsupported();
    }
  }

  // Esc 和系统手势退出都不经过我们的代码，按钮状态只能靠 fullscreenchange 回写，
  // 否则用户已经退出、HUD 还停在"退出全屏"，下一次点击反而会重新进全屏。
  function sync() {
    const on = !!current();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    if (supported) btn.title = "全屏" + '（F）';
    const body = document.body;
    if (body && body.classList) body.classList.toggle('fullscreen', on);
  }

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'f' && ev.key !== 'F') return;
    const t = ev.target;
    // 盘号 / 种子这类输入框里打字不能触发全屏，否则玩家输 seed 输到一半屏幕没了。
    if (t && /input|textarea|select/i.test(t.tagName || '')) return;
    if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    toggle();
  });
  window.addEventListener('fullscreenchange', sync);
  window.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('MSFullscreenChange', sync);
  sync();
})();

// ---- 静音开关（M）-----------------------------------------------------------------
// M 键切静音，与全屏/重开/提示同一套键位。
// 这里只负责把按键翻译成"点一下音效按钮"：真静音在 js/audio/synth.js 里做
// （suspend AudioContext + 静音态不再新建振荡器节点），偏好由它落盘到 localStorage。
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName || '')) return;
  if (ev.key === 'm' || ev.key === 'M') {
    ev.preventDefault();
    $('#btn-sound').click();
  }
});

// ---- 暂停：真的把仿真冻住 ----
//
// 本仓唯一持续推进的仿真是耗时时钟（startedAt 跟 Date.now 走，ticker 是它唯一心跳）。
// setPaused(true) 调 stopClock()：baseElapsed 落账、startedAt 归 0、ticker 停，
// 此后 clock() 恒等于 baseElapsed，墙钟再走多久都加不上去。
// setPaused(false) 调 startClock()：startedAt 复位成"从现在起"，
// 所以恢复后的第一帧不会把暂停期间憋下的墙钟一次性灌进来（没有 dt 尖峰）。
//
// 用 var 而不是 let：本块在文件末尾，而 startClock() 可能在它之前就被 begin() 调过；
// let 声明提升不到初始化，TDZ 会直接抛 ReferenceError。
var paused = false;
function setPaused(v) {
  v = !!v;
  if (v === paused) return paused;
  if (v) stopClock(); else startClock();
  paused = v;
  var b = document.getElementById('btn-pause');
  if (b) {
    b.setAttribute('aria-pressed', String(paused));
    b.textContent = paused ? '继续' : '暂停';
    b.title = paused ? '继续 (P)' : '暂停 (P)';
  }
  return paused;
}
function togglePause() { return setPaused(!paused); }
function isPaused() { return paused; }

document.getElementById('btn-pause').addEventListener('click', togglePause);
window.addEventListener('keydown', function (ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
  var k = ev.key;
  if (k === 'p' || k === 'P') { ev.preventDefault(); togglePause(); }
});
