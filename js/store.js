// Persistence. Everything lives under one key so a reset is one line, and a run in progress is
// stored as (origin seed, tier, the digits and pencil marks so far, what the run has cost) rather
// than a copy of the clue set or the solution — the generator is deterministic, so the board never
// has to travel through storage, and a solved 6×6 comes to about sixty bytes.

export const KEY = 'skyscraper.save.v1';

const defaults = () => ({
  settings: { sound: true, reduceMotion: false },
  best: {},
  totals: { solved: 0, hints: 0, ms: 0 },
  resume: null,
  campaign: {},
  daily: {},
});

// Cell values are 0 empty / 1..n, and pencil marks are candidate bitmasks; an early board is mostly
// zeros, so run-length coding is why a 36-cell save is not a 1 KB JSON array. No offset is needed:
// nothing here is negative — the engine's own NO_CLUE sentinel never reaches storage, because
// storage holds the player's ink and not the clue set.
function rleEncode(board) {
  const out = [];
  let run = board[0] ?? 0;
  let n = 1;
  for (let i = 1; i < board.length; i++) {
    if (board[i] === run && n < 255) n++;
    else {
      out.push(run, n);
      run = board[i];
      n = 1;
    }
  }
  out.push(run, n);
  return out;
}

function rleDecode(pairs, len) {
  const b = new Uint8Array(len);
  let i = 0;
  for (let p = 0; p + 1 < pairs.length; p += 2) {
    const v = pairs[p];
    const n = pairs[p + 1];
    if (!(n > 0)) continue;
    for (let k = 0; k < n && i < len; k++) b[i++] = v;
  }
  return b;
}

// Pencil marks are 16-bit masks, so each goes out as two bytes: the run-length coder then collapses
// the long stretches of "no marks here" exactly as well as it collapses empty cells.
function encodeNotes(notes) {
  const bytes = new Uint8Array(notes.length * 2);
  for (let i = 0; i < notes.length; i++) {
    bytes[i * 2] = notes[i] & 0xff;
    bytes[i * 2 + 1] = (notes[i] >>> 8) & 0xff;
  }
  return rleEncode(bytes);
}

function decodeNotes(pairs, cells) {
  const bytes = rleDecode(pairs, cells * 2);
  const out = new Int32Array(cells);
  for (let i = 0; i < cells; i++) out[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  return out;
}

// Storage is read once, at import, and the copy in memory is the only thing the app mutates. That
// is what the "two readers" assertion in tools/engine-test.mjs is about: a half-written
// localStorage entry must not be able to disagree with what the running game believes.
function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults();
    const base = defaults();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      totals: { ...base.totals, ...(parsed.totals || {}) },
      best: sanitizeBest(parsed.best),
      campaign: sanitizeRuns(parsed.campaign),
      daily: sanitizeRuns(parsed.daily),
      resume: sanitizeResume(parsed.resume),
    };
  } catch {
    return defaults();
  }
}

const int = (v, min, max) => (Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : min);

// Anything a previous version, another tab, or a hand-edited profile could leave behind has to be
// either usable or absent — never believed.
function sanitizeRuns(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue;
    out[String(k).slice(0, 40)] = {
      ms: int(v.ms, 0, 86400000),
      hints: int(v.hints, 0, 9999),
      moves: int(v.moves, 0, 99999),
      at: int(v.at, 0, Number.MAX_SAFE_INTEGER),
    };
  }
  return out;
}

function sanitizeBest(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || !Number.isFinite(v.ms)) continue;
    out[String(k).slice(0, 40)] = {
      ms: int(v.ms, 0, 86400000),
      hints: int(v.hints, 0, 9999),
      moves: int(v.moves, 0, 99999),
      size: typeof v.size === 'string' ? v.size.slice(0, 12) : '',
      at: int(v.at, 0, Number.MAX_SAFE_INTEGER),
    };
  }
  return out;
}

// Both channels arrive either as the flat [value, run] pairs the coder writes or as the decoded
// typed arrays this module keeps in memory — `read()` sanitizes at import and `Store.resume()`
// sanitizes again, so a run in progress has to survive being looked at twice. Without this the
// second pass would answer "no resume" and reloading the page would silently drop the board the
// player was working on.
const cellsOf = (v, cells) => (v instanceof Uint8Array ? Uint8Array.from(v) : Array.isArray(v) ? rleDecode(v, cells) : null);
const notesOf = (v, cells) => (v instanceof Int32Array ? Int32Array.from(v) : Array.isArray(v) ? decodeNotes(v, cells) : null);

function sanitizeResume(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cells = int(raw.cells, 1, 64);
  const board = cellsOf(raw.ink, cells);
  const notes = notesOf(raw.notes, cells);
  if (!board || !notes) return null;
  return {
    seed: typeof raw.seed === 'string' ? raw.seed.slice(0, 64) : '',
    tier: typeof raw.tier === 'string' ? raw.tier.slice(0, 20) : '',
    kind: raw.kind === 'level' || raw.kind === 'daily' ? raw.kind : 'tier',
    levelId: typeof raw.levelId === 'string' ? raw.levelId.slice(0, 40) : null,
    dateKey: typeof raw.dateKey === 'string' ? raw.dateKey.slice(0, 20) : null,
    elapsedMs: int(raw.elapsedMs, 0, 86400000),
    cells,
    ink: board,
    notes,
    moves: int(raw.moves, 0, 99999),
    hints: int(raw.hints, 0, 9999),
    at: int(raw.at, 0, Number.MAX_SAFE_INTEGER),
  };
}

export const Store = {
  data: read(),
  // False in a private tab: the game stays playable, it just stops remembering. Every writer below
  // consults this instead of assuming localStorage answered.
  persistent: (() => {
    try {
      return typeof localStorage !== 'undefined';
    } catch {
      return false;
    }
  })(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* private mode / quota — the game is still playable, just forgetful */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },
  // Best time is decided by *least help taken* first: a record must mean "I worked this board out
  // myself", and a fast run built on six hints is not that.
  recordBest(tier, { ms, hints, moves, size }) {
    const cur = this.data.best[tier];
    const better =
      !cur ||
      hints < cur.hints ||
      (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  // Campaign: a level is cleared once, and the next chapter unlocks when the one before it is
  // finished — so `unlocked` is read off the archive, never off a flag in the level list.
  clearLevel(id, { ms, hints, moves }) {
    const had = this.data.campaign[id];
    if (!had || hints < had.hints) this.data.campaign[id] = { ms, hints, moves, at: Date.now() };
    this.save();
    return !had;
  },
  levelCleared(id) {
    return !!this.data.campaign[id];
  },
  clearedCount() {
    return Object.keys(this.data.campaign).length;
  },

  markDaily(dateKey, { ms, hints, moves }) {
    const had = this.data.daily[dateKey];
    if (!had || hints < had.hints) this.data.daily[dateKey] = { ms, hints, moves, at: Date.now() };
    this.save();
    return !had;
  },
  dailyDone(dateKey) {
    return !!this.data.daily[dateKey];
  },

  saveResume(puzzle, state, elapsedMs, run) {
    this.data.resume = {
      // The generator derives an internal seed from what it is handed, so a resume has to store
      // the *origin* seed or the rebuilt board would not be the same one.
      seed: puzzle.originSeed || puzzle.seed,
      tier: puzzle.tier,
      kind: puzzle.kind || 'tier',
      levelId: puzzle.levelId || null,
      dateKey: puzzle.dateKey || null,
      elapsedMs,
      cells: puzzle.n * puzzle.n,
      ink: rleEncode(state.cell),
      notes: encodeNotes(state.notes),
      // The cost of the run travels with the board. Without it a player could take six hints,
      // close the tab, come back, and finish with a clean 提示 0 record — the number that
      // decides the best time is counted from actions, and actions are not saved.
      moves: run.moves,
      hints: run.hints,
      at: Date.now(),
    };
    this.save();
  },

  resume() {
    return sanitizeResume(this.data.resume);
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    this.data = defaults();
    this.save();
    try {
      // reset means gone from both sides, not just from the copy in memory
      localStorage.removeItem(KEY);
    } catch {
      /* nothing to take away */
    }
  },

  // What is actually in storage, for the harness and the tests — parsed by the same sanitiser that
  // read it the first time, so a reader and a writer cannot disagree about what a dirty row means.
  peek() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
};

export const _internals = { rleEncode, rleDecode, encodeNotes, decodeNotes, defaults, sanitizeResume };
