// The playable state machine: what a tap does, what an undo takes back, when a board counts as
// solved, and what a hint is allowed to say.
//
// Two deliberate bindings to js/engine/skyscraper.js:
//   * the ink lives in the engine's own `st.cell` / `st.notes` arrays, and the win check is the
//     engine's independent `verify()` — written from the rules of the game rather than from this
//     file's bookkeeping — so "the UI said I won" cannot disagree with "every clue adds up".
//   * hints are read out of a script the *clues* produced (`solve()`), never out of the player's
//     own marks. A wrong digit therefore cannot teach the hints to agree with the mistake: the
//     engine keeps saying what the printed counts actually force.

import {
  createState,
  setCell,
  toggleNote,
  clearNotes,
  snapshot,
  undo as undoState,
  resetInk,
  solve,
  verify,
  complete,
  deadEnd,
  diagnose,
  rulesUsed,
  fullMask,
  Rules,
  EMPTY,
  NO_CLUE,
  bit,
  valuesIn,
} from '../engine/skyscraper.js';

export { EMPTY, NO_CLUE };

export const INK = 'ink'; // a tap writes a height, cycling 1..n
export const NOTE = 'note'; // a tap toggles one candidate under the keypad digit

export class Game {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.board = puzzle.board;
    this.w = puzzle.n;
    this.h = puzzle.n;
    this.st = createState(puzzle.board);
    this.steps = [];
    // The whole hint script is computed once, from the clues alone. `solve()` is the same function
    // the generator used to accept this board, so a hint can never be a fact the clues do not
    // force — and a board the generator shipped cannot hand out a hint that runs out.
    this.script = solve(puzzle.board).rows;
    this.cursor = 0;
    this.moves = 0;
    this.hints = 0;
    this.status = 'playing';
    this.mode = INK;
    this.digit = 1; // what the keypad and NOTE mode write; clamped to this board's 1..n
    this.selected = 0;
    this.lastHint = null;
    this.recompute();
  }

  // 重开**同一道题**：把这一局整个归零，题面不动。
  //
  // 陷阱就在这里：引擎的 resetInk() 只清了 st.cell / st.notes 与引擎 history，而撤销栈
  // this.steps、步数 this.moves、提示次数 this.hints、提示游标 this.cursor、胜负
  // this.status、临时态 this.mode、键盘选的数字 this.digit、键盘选中的格 this.selected、
  // 上一条提示文案 this.lastHint 全挂在 UI 这一层的 Game 实例上，它一个都碰不到。
  // 只调 resetInk() 当重开，这半局的痕迹会原封不动当成新局开场白，玩家还按得动撤销
  // 回到走错那一步（实测 steps 6 → 6、cursor 40 → 40）。
  //
  // selected 与 digit 也要点名：本仓有纯键盘操作（方向键选格、数字键选数、回车落子），
  // 重开时选中的格与选中的数字停留在上一局，玩家第一下回车会写进一个他没看见的格。
  resetAll() {
    resetInk(this.st);       // st.cell / st.notes 全回空 + 引擎 history 清空
    this.steps = [];         // UI 撤销栈：resetInk 管不到，清的是引擎那份
    this.moves = 0;          // 步数归零
    this.hints = 0;          // 提示次数归零：提示要收钱，留着等于让玩家白嫖上一局的帮助
    this.cursor = 0;         // 提示脚本从头再来，否则重开后的第一条提示会被跳过
    this.status = 'playing'; // 胜负回判：上一局赢了也不能把重开后的盘算成已通关
    this.mode = INK;         // 临时态：落笔模式回到默认
    this.digit = 1;          // 键盘选中的数字回默认：停在上一局那个数上，第一下回车就写错
    this.selected = 0;       // 键盘选中的格回第一格：同上
    this.lastHint = null;    // 上一条提示文案属于上一局
    this.recompute();        // diag / problems / dead 一并重算，否则面板上留着上一局的判词
    return this;
  }

  recompute() {
    this.diag = diagnose(this.board, this.st.cell, this.st.notes);
    this.problems = verify(this.board, this.st.cell).filter((b) => b.why !== '空格');
    // null while the ink can still be completed, a sentence once it cannot. Sound in one
    // direction only: the pencil rules are incomplete, so this can say "already lost", never
    // "this is fine".
    this.dead = deadEnd(this.board, this.st.cell);
    return this.diag;
  }

  cellAt(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  valueOf(i) {
    return i >= 0 && i < this.board.size ? this.st.cell[i] : EMPTY;
  }

  notesOf(i) {
    return i >= 0 && i < this.board.size ? this.st.notes[i] : 0;
  }

  // Every gesture consumes exactly one engine snapshot and records the cells it changed with their
  // prior values, so 撤销 is an exact reverse rather than a re-derivation.
  commit(kind, info) {
    this.steps.push({ kind, ...info });
    if (kind === 'hint') this.hints++;
    else this.moves++;
    this.recompute();
    this.checkWin();
    return this.steps[this.steps.length - 1];
  }

  select(i) {
    if (i < 0 || i >= this.board.size) return this.selected;
    this.selected = i;
    return i;
  }

  setDigit(v) {
    if (v < 1 || v > this.w) return false;
    this.digit = v;
    return true;
  }

  // A tap on a cell in 数字 mode walks it round the ring 空 → 1 → … → n → 空: one gesture, one
  // undo step, and no mode switching needed to correct a digit that is one too high.
  tap(i, mode = this.mode) {
    if (this.status === 'won' || i < 0) return null;
    this.select(i);
    if (mode === NOTE) return this.toggleNote(i, this.digit);
    const from = this.st.cell[i];
    const to = from >= this.w ? EMPTY : from + 1;
    if (!setCell(this.st, i, to)) return null;
    return this.commit('tap', { writes: [{ cell: i, from: { v: from, notes: 0 }, to: { v: to } }], value: to });
  }

  // The keypad writes an exact digit — including 空, which is what 清除 does.
  put(i, value) {
    if (this.status === 'won' || i < 0) return null;
    this.select(i);
    const from = this.st.cell[i];
    if (from === value) return null;
    if (!setCell(this.st, i, value)) return null;
    return this.commit('put', { writes: [{ cell: i, from: { v: from }, to: { v: value } }], value });
  }

  toggleNote(i, value) {
    if (this.status === 'won' || i < 0) return null;
    const before = this.st.notes[i];
    if (!toggleNote(this.st, i, value)) return null;
    if (before === this.st.notes[i]) return null;
    this.setDigit(value);
    return this.commit('note', { writes: [{ cell: i, from: { notes: before }, to: { notes: this.st.notes[i] } }], value });
  }

  wipeNotes() {
    if (!clearNotes(this.st)) return null;
    return this.commit('wipe', { writes: [{ notes: 0 }], value: EMPTY });
  }

  // A stroke of the same digit across cells: the whole drag is one undo step.
  stroke(cells, value) {
    if (this.status === 'won') return null;
    const writes = [];
    const seen = new Set();
    for (const i of cells) {
      if (i < 0 || i >= this.board.size || seen.has(i)) continue;
      seen.add(i);
      if (this.st.cell[i] === value) continue;
      writes.push({ cell: i, from: { v: this.st.cell[i] }, to: { v: value } });
    }
    if (!writes.length) return null;
    snapshot(this.st);
    for (const w of writes) this.st.cell[w.cell] = w.to.v;
    return this.commit('stroke', { writes, value });
  }

  load(cells, notes = null) {
    for (let i = 0; i < this.board.size; i++) {
      const v = cells[i];
      this.st.cell[i] = v >= 1 && v <= this.w ? v : EMPTY;
      this.st.notes[i] = notes ? notes[i] & fullMask(this.w) : 0;
    }
    this.recompute();
    this.checkWin();
    return this;
  }

  undo() {
    const step = this.steps.pop();
    if (!step) return null;
    undoState(this.st);
    if (step.kind === 'wipe') {
      // the snapshot already restored every note; nothing else to put back
    }
    // A hint taken back is still a hint that was taken: records rank runs by help used, so
    // refunding the counter would let a player undo their way to a clean 提示 0.
    if (step.kind !== 'hint') this.moves = Math.max(0, this.moves - 1);
    this.recompute();
    return step;
  }

  // The next fact the clues force that the player has not written yet. Placements are written; a
  // candidate the pencil path already killed is struck from the player's own notes. Rows that have
  // nothing left to do are consumed without being charged, because charging for an already-finished
  // step would bill the player for work they did themselves.
  hint() {
    if (this.status === 'won') return null;
    while (this.cursor < this.script.length) {
      const row = this.script[this.cursor];
      if (row.kind === 'place') {
        const cur = this.st.cell[row.cell];
        if (cur === row.value) {
          this.cursor++;
          continue;
        }
        if (cur !== EMPTY) {
          // the player's own digit contradicts what the clues force: say so, charge nothing
          return {
            conflict: `${this.board.cellName(row.cell)} 上写着 ${cur}，可 ${row.rule.name} 说这里必须是 ${row.value}——依据是 ${clueOf(this.board, row)}。`,
            cell: row.cell,
          };
        }
        const from = { v: cur };
        setCell(this.st, row.cell, row.value);
        this.cursor++;
        this.commit('hint', { writes: [{ cell: row.cell, from, to: { v: row.value } }], value: row.value, rule: row.rule.name });
        return this.report(row, { charged: true });
      }
      const stale = this.st.notes[row.cell] & valuesMask(row.values);
      if (stale) {
        const from = { notes: this.st.notes[row.cell] };
        // The note channels are mutated directly here (a hint strikes several candidates at once,
        // which toggleNote cannot do), so the snapshot this gesture consumes has to be taken by
        // hand — exactly as stroke() does. Without it, 撤销 after a struck candidate would rewind
        // some older gesture instead of this one.
        snapshot(this.st);
        this.st.notes[row.cell] &= ~stale;
        this.cursor++;
        this.commit('hint', { writes: [{ cell: row.cell, from, to: { notes: this.st.notes[row.cell] } }], value: EMPTY, rule: row.rule.name });
        return this.report(row, { charged: true });
      }
      this.cursor++;
      return this.report(row, { charged: false });
    }
    return { stalled: true, text: '线索能推的都已经推完了：剩下的格只能自己收尾。' };
  }

  // The text a hint shows is the rule's own sentence, written by the engine — never a summary made
  // up here, so what the panel says and what the deduction proves cannot drift apart.
  report(row, { charged }) {
    const info = {
      rule: row.rule.name,
      level: row.rule.level,
      kind: row.kind,
      cell: row.cell,
      clueIdx: row.clueIdx,
      values: row.values || (row.value ? [row.value] : []),
      why: row.rule.text(this.board, row),
      charged,
    };
    this.lastHint = info;
    return info;
  }

  checkWin() {
    this.status = complete(this.board, this.st.cell) ? 'won' : 'playing';
    return this.status === 'won';
  }

  // Only used by the verification harness and the "solve it for me" path: play the clue-derived
  // script to the end. Every cell it writes is one the pencil rules justify.
  //
  // Progress is read off the cursor, not off the step counter: a prune row whose candidate the
  // player never wrote is consumed without charging anything — that is hint() working as designed,
  // not a dead end. Treating "no step recorded" as a stop made this path quit at the first such row
  // and report a board the pencil path finishes outright as unfinishable.
  solveWithLogic({ cap = 6000 } = {}) {
    let k = 0;
    while (this.status !== 'won' && k++ < cap) {
      const before = this.cursor;
      const h = this.hint();
      if (!h || h.stalled || h.conflict) break;
      if (this.cursor === before) break;
    }
    return { status: this.status, steps: k, hints: this.hints };
  }

  state() {
    const g = this.diag;
    return {
      tier: this.puzzle.tier,
      kind: this.puzzle.kind || 'tier',
      name: this.puzzle.name || this.puzzle.tierName,
      seed: this.puzzle.seed,
      originSeed: this.puzzle.originSeed,
      moves: this.moves,
      hints: this.hints,
      status: this.status,
      n: this.w,
      filled: g.filled,
      total: g.total,
      remaining: g.remaining,
      clues: g.clues,
      satisfied: g.satisfied.size,
      conflicts: g.violated.size,
      noteErrors: g.noteErrors.length,
      badCells: g.badCells.size,
      dead: this.dead,
      score: this.puzzle.score,
      steps: this.steps.length,
      mode: this.mode,
      digit: this.digit,
      selected: this.selected,
      script: this.script.length,
      cursor: this.cursor,
      rules: rulesUsed(this.script),
    };
  }
}

function valuesMask(list) {
  return (list || []).reduce((m, v) => m | bit(v), 0);
}

// Which printed number a derivation step leaned on — the sentence a hint has to be able to say.
function clueOf(board, row) {
  if (row.clueIdx == null || row.clueIdx < 0) return board.trackName(row.track) || '这条线本身的规则';
  return `${board.clueName(row.clueIdx)}=${board.clue[row.clueIdx]}`;
}

export { Rules, valuesIn };
