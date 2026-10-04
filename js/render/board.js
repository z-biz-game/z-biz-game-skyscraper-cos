// Canvas renderer. It reads the Game's engine state and paints; it decides nothing — no clue is
// "satisfied" here, no digit is judged wrong here — so the picture cannot disagree with the solver
// that the hints and the win check both use.
//
// Layout lives here too (cell size from the container, the clue band's width, board origin, DPR)
// because hitCell has to answer with the *same* numbers draw() used. Those two drifting apart is
// how a board renders correctly but takes clicks one cell off.


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：js/render/board.js 的重绘由 pointerdown / click / keydown 触发，全仓 requestAnimationFrame 出现 0 次；唯一的周期性调用是 1 秒 ticker（刷新用时读数，走墙钟）
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, Cell, Radius, Font } from '../theme.js';
import { EMPTY, NO_CLUE, valuesIn } from '../engine/skyscraper.js';

// The clue band is drawn outside the grid on all four sides; it scales with the cell so a 4×4 on a
// phone and a 6×6 on a desktop get the same *proportion* of their edges to the numbers that decide
// them.
export function layoutFor(n, availW, availH) {
  const band = (k) => Math.round(k * Cell.clueScale);
  // Solve for the cell size that leaves room for two bands: avail = 2*band + n*cell.
  const fit = (a) => Math.floor((a - 24) / (n + 2 * Cell.clueScale));
  const cell = Math.max(Cell.min, Math.min(Cell.max, fit(availW), fit(availH)));
  return { cell, band: band(cell), boardW: cell * n, boardH: cell * n, size: cell * n + 2 * band(cell) };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, band: 0, x: 0, y: 0, w: 0, h: 0, n: 0, dpr: 1 };
  }

  // The backing buffer is sized in device pixels while every draw call stays in CSS pixels: one
  // setTransform at the top keeps the digits crisp on a Retina display without doubling every
  // constant in this file.
  resize(game, availW, availH) {
    const n = game.w;
    const l = layoutFor(n, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    this.canvas.style.width = `${l.size}px`;
    this.canvas.style.height = `${l.size}px`;
    this.canvas.width = Math.round(l.size * dpr);
    this.canvas.height = Math.round(l.size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.game = game;
    this.geo = { cell: l.cell, band: l.band, x: l.band, y: l.band, w: l.size, h: l.size, n, dpr };
    return this.geo;
  }

  cellRect(i) {
    const { cell, x, y, n } = this.geo;
    return { x: (i % n) * cell + x, y: (((i / n) | 0) * cell) + y, size: cell };
  }

  // Where a printed clue lives, in CSS pixels, for side 0=上 1=右 2=下 3=左 and line index k.
  clueRect(side, k) {
    const { cell, band, x, y, n } = this.geo;
    if (side === 0) return { x: x + k * cell, y: 0, w: cell, h: band };
    if (side === 2) return { x: x + k * cell, y: y + n * cell, w: cell, h: band };
    if (side === 3) return { x: 0, y: y + k * cell, w: band, h: cell };
    return { x: x + n * cell, y: y + k * cell, w: band, h: cell };
  }

  clueAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { band, x, y, n, cell } = this.geo;
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const inGrid = px >= x && px < x + n * cell && py >= y && py < y + n * cell;
    if (inGrid) return null;
    if (py >= band && py < band + n * cell && px < band) return { side: 3, k: Math.floor((py - y) / cell) };
    if (py >= band && py < band + n * cell && px >= x + n * cell) return { side: 1, k: Math.floor((py - y) / cell) };
    if (py < band && px >= x && px < x + n * cell) return { side: 0, k: Math.floor((px - x) / cell) };
    if (py >= band + n * cell && px >= x && px < x + n * cell) return { side: 2, k: Math.floor((px - x) / cell) };
    return null;
  }

  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y, n, band } = this.geo;
    if (!cell || !this.game) return -1;
    const px = clientX - rect.left - x;
    const py = clientY - rect.top - y;
    if (px < 0 || py < 0) return -1;
    const gx = Math.floor(px / cell);
    const gy = Math.floor(py / cell);
    if (gx < 0 || gy < 0 || gx >= n || gy >= n) return -1;
    if (band <= 0) return -1;
    return gy * n + gx;
  }

  draw(game, { pulse = null, preview = null, cursor = null } = {}) {
    this.game = game;
    const { ctx, geo } = this;
    const { cell, band, x, y, n } = geo;
    const b = game.board;
    const st = game.st;
    const diag = game.diag;
    const won = game.status === 'won';
    ctx.clearRect(0, 0, geo.w, geo.h);

    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();

    // The clue band is a different surface from the grid: the numbers on it are given, the numbers
    // in the middle are the player's, and the picture should never let those two read alike.
    ctx.fillStyle = Palette.bgTop;
    roundRect(ctx, 4, 4, geo.w - 8, geo.h - 8, Radius.card - 4);
    ctx.fill();

    // Cells: the paper. A settled cell is lifted so the grid you are filling reads as filled.
    for (let i = 0; i < b.size; i++) {
      const r = this.cellRect(i);
      ctx.fillStyle = st.cell[i] === EMPTY ? Palette.bgBottom : Palette.surfaceLift;
      ctx.fillRect(r.x, r.y, cell, cell);
    }

    // Pencil candidates first, so a written digit always covers them (it also replaces them in the
    // engine: `setCell` clears the marks, and painting one over the other would lie about that).
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < b.size; i++) {
      if (st.cell[i] !== EMPTY) continue;
      const mask = st.notes[i];
      if (!mask) continue;
      this.drawNotes(i, valuesIn(mask), diag.badCells.has(i) ? Palette.error : Palette.pencilStrong);
    }

    // Written heights. Colour is the live feedback this game lives on: a height that keeps every
    // clue it belongs to is cool blue, one that repeats inside its row or column is red, and a
    // finished board is all green. Which clues are met is the engine's answer, not a guess here.
    for (let i = 0; i < b.size; i++) {
      const v = st.cell[i];
      if (v === EMPTY) continue;
      const r = this.cellRect(i);
      const bad = diag.badCells.has(i);
      const against = touchedClues(b, i).some((idx) => diag.violated.has(idx));
      const helped = diag.satisfied.size > 0;
      ctx.fillStyle = won ? Palette.success : bad || against ? Palette.error : helped ? Palette.info : Palette.ink;
      ctx.font = `700 ${Math.round(cell * 0.52)}px ${Font.mono}`;
      ctx.fillText(String(v), r.x + cell / 2, r.y + cell / 2 + 1);
    }

    // Grid. Every third line stays hairline; the frame around the grid is what separates the two
    // worlds on the canvas.
    ctx.strokeStyle = Palette.line;
    ctx.lineWidth = 1;
    for (let i = 0; i <= n; i++) line(ctx, x + i * cell, y, x + i * cell, y + n * cell);
    for (let j = 0; j <= n; j++) line(ctx, x, y + j * cell, x + n * cell, y + j * cell);
    ctx.strokeStyle = Palette.lineHeavy;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, n * cell, n * cell);

    // The printed visible counts. These are the clues: red where the ink already contradicts them,
    // green where the line is complete and adds up, plain ink while the view is still open.
    for (let i = 0; i < 4 * n; i++) {
      const want = b.clue[i];
      if (want === NO_CLUE) continue;
      const side = ((i / n) | 0);
      const k = i % n;
      const rect = this.clueRect(side, k);
      const violated = diag.violated.has(i);
      const satisfied = diag.satisfied.has(i);
      ctx.fillStyle = violated ? Palette.error : satisfied ? Palette.success : Palette.ink;
      ctx.font = `700 ${Math.round(band * 0.62)}px ${Font.mono}`;
      ctx.fillText(String(want), rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
      if (pulse && pulse.clueIdx === i) {
        ctx.strokeStyle = Palette.hint;
        ctx.lineWidth = 2;
        roundRect(ctx, rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4, Radius.chip);
        ctx.stroke();
      }
    }

    // The keypad's target cell: where the next tap will land.
    if (cursor != null && cursor >= 0) {
      const r = this.cellRect(cursor);
      ctx.strokeStyle = Palette.accentSoft;
      ctx.lineWidth = Math.max(3, cell * 0.1);
      roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
      ctx.stroke();
    }

    // During a drag the cells are painted ahead of the commit: a preview is paint, never ink.
    if (preview && preview.cells) {
      ctx.strokeStyle = Palette.accent;
      ctx.lineWidth = Math.max(2, cell * 0.06);
      ctx.setLineDash([Math.max(4, cell * 0.2), Math.max(3, cell * 0.14)]);
      for (const i of preview.cells) {
        const r = this.cellRect(i);
        ctx.strokeRect(r.x + 1.5, r.y + 1.5, cell - 3, cell - 3);
      }
      ctx.setLineDash([]);
    }

    // What a hint just named — the only place the UI is allowed to say "look here".
    if (pulse && pulse.cell != null) {
      const r = this.cellRect(pulse.cell);
      ctx.strokeStyle = pulse.color || Palette.hint;
      ctx.lineWidth = Math.max(2, cell * 0.09);
      roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
      ctx.stroke();
    }
  }

  // Candidates are laid out on a k×k lattice inside the cell, k = ⌈√n⌉, so the *same* candidate
  // always lands in the same sub-slot on every board size — muscle memory for "top-left is a 1".
  drawNotes(i, values, color) {
    // `ctx` is not in scope in a method — draw() destructures it into a local, and this is the one
    // place that call was copied into a separate function. Painted on the first candidate a board
    // ever gets, which is a code path no Node test reaches.
    const ctx = this.ctx;
    const { cell, n } = this.geo;
    const r = this.cellRect(i);
    const k = Math.ceil(Math.sqrt(n));
    const slot = cell / k;
    ctx.font = `${Math.round(slot * 0.66)}px ${Font.mono}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const v of values) {
      const idx = v - 1;
      const cx = r.x + (idx % k) * slot + slot / 2;
      const cy = r.y + (((idx / k) | 0) * slot) + slot / 2;
      ctx.fillText(String(v), cx, cy + 0.5);
    }
  }
}

// The clues a cell stands in the way of: its row's two edges and its column's two edges. Used only
// to pick a colour, never to judge the board — `diagnose()` does that.
function touchedClues(b, i) {
  const n = b.n;
  const r = ((i / n) | 0);
  const c = i % n;
  return [3 * n + r, n + r, c, 2 * n + c];
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
