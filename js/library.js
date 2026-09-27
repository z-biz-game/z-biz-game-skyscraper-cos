// What the shipped content is: the baked campaign, today's board, and the round trip between a
// serialised clue set and a live board.
//
// The campaign rows come out of `js/data/levels.js`, which `tools/bake.mjs` writes and re-derives.
// A row is not a puzzle description — it is a *measurement*, and `bake --check` fails the build if
// the printed numbers stop coming back out of the clue string, so nothing here has to trust them.
//
// Daily and random boards are generated at run time instead (the generator is deterministic and
// costs a few milliseconds), which is why the store only ever persists a seed and a tier.

import { NO_CLUE, createBoard, clueName } from './engine/skyscraper.js';
import { TIERS, tierFor, makePuzzle, dailySeed } from './engine/generate.js';
import { dateSeed } from './engine/rng.js';
import { LEVELS, PROOF, TIERS_META } from './data/levels.js';
import { Store } from './store.js';

// Clue strings are 4n characters: a digit is a printed visible count, a dot is an edge with nothing
// on it. Human-readable in the baked file, and one `charAt` per edge to decode.
export function decodeClue(n, text) {
  if (typeof text !== 'string' || text.length !== 4 * n) throw new Error(`线索串应该是 ${4 * n} 个字符，收到 ${text == null ? text : text.length} 个`);
  const out = new Int8Array(4 * n);
  for (let i = 0; i < 4 * n; i++) {
    const ch = text[i];
    if (ch === '.') out[i] = NO_CLUE;
    else if (ch >= '1' && ch <= '9') out[i] = Number(ch);
    else throw new Error(`${clueName(n, i)} 上写着「${ch}」，不是数字也不是点`);
  }
  return out;
}

export function encodeClue(clue) {
  let out = '';
  for (let i = 0; i < clue.length; i++) out += clue[i] === NO_CLUE ? '.' : String(clue[i]);
  return out;
}

export function decodeGrid(n, text) {
  if (typeof text !== 'string' || text.length !== n * n) throw new Error(`答案串应该是 ${n * n} 个数字`);
  const out = new Uint8Array(n * n);
  for (let i = 0; i < out.length; i++) {
    const v = Number(text[i]);
    if (!(v >= 1 && v <= n)) throw new Error(`第 ${i + 1} 格写着「${text[i]}」，超出 1..${n}`);
    out[i] = v;
  }
  return out;
}

export function encodeGrid(grid) {
  let out = '';
  for (const v of grid) out += String(v);
  return out;
}

// A baked row, live. The board is re-built from the clue string on the spot; the printed score and
// step count are what bake measured and what `--check` re-measures, not what the game plays by.
export function boardOfRow(row) {
  return createBoard({ n: row.n, clue: decodeClue(row.n, row.clue) });
}

const CHAPTER_NOTE = {
  novice: '四条边几乎写满：一眼能看见的数直接给出格子',
  casual: '边上的数少了，得开始问"这一行的摆法还剩几种"',
  regular: '五阶，最高楼能站的位置要两头一起算',
  sharp: '五阶，线索稀到只剩整行排列集推得动',
  master: '六阶，几格候选挤在同样几格里，Hall 家族才解得开',
};

export const CHAPTERS = TIERS.map((t, i) => ({
  index: i,
  tier: t.key,
  name: t.name,
  n: t.n,
  band: t.band,
  blurb: CHAPTER_NOTE[t.key],
  levels: LEVELS.filter((l) => l.tier === t.key),
}));

export function chapterOf(levelId) {
  return CHAPTERS.find((c) => c.levels.some((l) => l.id === levelId)) || null;
}

export function levelById(id) {
  return LEVELS.find((l) => l.id === id) || null;
}

// A chapter opens when the one before it is cleared. The archive is the only input, so unlocking is
// a fact about what the player has done rather than a flag that could be edited.
export function chapterUnlocked(index) {
  if (index <= 0) return true;
  for (let i = 0; i < index; i++) {
    const ch = CHAPTERS[i];
    if (!ch.levels.length) continue;
    if (!ch.levels.every((l) => Store.levelCleared(l.id))) return false;
  }
  return true;
}

export function chapterProgress(index) {
  const ch = CHAPTERS[index];
  if (!ch) return { done: 0, total: 0 };
  const done = ch.levels.filter((l) => Store.levelCleared(l.id)).length;
  return { done, total: ch.levels.length };
}

export function puzzleFromLevel(row) {
  const board = boardOfRow(row);
  return {
    board,
    n: row.n,
    w: row.n,
    h: row.n,
    tier: row.tier,
    tierName: tierFor(row.tier).name,
    kind: 'level',
    levelId: row.id,
    name: row.name,
    size: `${row.n}×${row.n}`,
    seed: row.seed || row.id,
    originSeed: row.seed || row.id,
    score: row.score,
    steps: row.steps,
    clues: row.clues,
    baked: true,
  };
}

export function puzzleFromTier(tierKey, seed) {
  const p = makePuzzle(seed, tierKey);
  if (!p) return null;
  return { ...p, kind: 'tier', name: p.tierName };
}

// Today's board: the tier rotates over the five rungs by day, so the daily gets harder and easier on
// a schedule rather than by taste, and every player on the same date gets the same one.
export function dailyPuzzle(at = new Date()) {
  const { key, epochDays } = dateSeedAt(at);
  const tier = TIERS[epochDays % TIERS.length];
  const p = makePuzzle(dailySeed(key), tier.key);
  if (!p) return null;
  return { ...p, kind: 'daily', dateKey: key, name: `日课 ${key}` };
}

function dateSeedAt(at) {
  const d = new Date(at.getTime());
  d.setHours(12, 0, 0, 0);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { key, epochDays: Math.floor(d.getTime() / 86400000) };
}

export { TIERS, tierFor, LEVELS, PROOF, TIERS_META, dateSeed };
