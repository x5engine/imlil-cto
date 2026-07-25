import { getDb } from './db.js';
import { xxh3 } from './hash.js';

const CHUNK_TABLES = `
CREATE TABLE IF NOT EXISTS chunk (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  hash      TEXT UNIQUE,
  path      TEXT,
  lang      TEXT,
  symbol    TEXT,
  start_ln  INTEGER,
  end_ln    INTEGER,
  text      TEXT,
  embedded  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunk_path ON chunk(path);
CREATE INDEX IF NOT EXISTS idx_chunk_hash ON chunk(hash);

CREATE TABLE IF NOT EXISTS file (
  path      TEXT PRIMARY KEY,
  mtime     INTEGER,
  size      INTEGER,
  hash      TEXT
);

-- vectors stored as BLOBs (float32[384], little-endian)
CREATE TABLE IF NOT EXISTS vector (
  chunk_id  INTEGER PRIMARY KEY,
  embedding BLOB,
  FOREIGN KEY (chunk_id) REFERENCES chunk(id) ON DELETE CASCADE
);

-- keyword side (identifiers, exact symbols)
DROP TABLE IF EXISTS fts_chunk;
CREATE VIRTUAL TABLE fts_chunk USING fts5(
  text, symbol, path,
  content='chunk',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
`;

// ─── Rebuild FTS5 index from chunk table ───
export async function rebuildFts() {
  const db = getDb();
  await db.run("INSERT INTO fts_chunk(fts_chunk) VALUES('rebuild')");
}

// ─── Sync FTS5 for a single chunk ───
export async function syncFtsForChunk(id) {
  const db = getDb();
  await db.run(
    `INSERT INTO fts_chunk(rowid, text, symbol, path)
     SELECT id, text, symbol, path FROM chunk WHERE id = ?`,
    id
  );
}

// ─── Schema Init ───
export async function initVectorDb() {
  const db = getDb();
  await db.exec(CHUNK_TABLES);
}

// ─── Chunk Insert ───
export async function insertChunk({ hash, path, lang, symbol, startLn, endLn, text }) {
  const db = getDb();
  await db.run(
    `INSERT OR IGNORE INTO chunk (hash, path, lang, symbol, start_ln, end_ln, text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    hash, path, lang, symbol || null, startLn, endLn, text
  );
  const row = await db.get('SELECT id, embedded FROM chunk WHERE hash = ?', hash);
  return row;
}

// ─── Batch Insert Vectors ───
export async function insertVectors(chunks) {
  const db = getDb();
  const stmt = await db.prepare(
    'INSERT OR REPLACE INTO vector (chunk_id, embedding) VALUES (?, ?)'
  );
  const updateStmt = await db.prepare(
    'UPDATE chunk SET embedded = 1 WHERE id = ?'
  );
  for (const { id, embedding } of chunks) {
    // embedding is Float32Array → Buffer
    const buf = Buffer.from(embedding.buffer);
    await stmt.run(id, buf);
    await updateStmt.run(id);
  }
}

// ─── Cosine Distance ───
function cosineDist(a, b) {
  const fa = new Float32Array(a.buffer || a);
  const fb = new Float32Array(b.buffer || b);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < fa.length; i++) {
    dot += fa[i] * fb[i];
    na += fa[i] * fa[i];
    nb += fb[i] * fb[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 1 : 1 - dot / denom;
}

// ─── Hybrid Search (RRF) ───
export async function hybridSearch(queryEmbedding, ftsQuery, opts = {}) {
  const db = getDb();
  const k = opts.topK || 10;
  const kConst = 60;  // RRF constant

  const results = {};

  // 1. Vector search — brute force (fast at 12K)
  const allVecs = await db.all(`
    SELECT v.chunk_id, v.embedding, c.path, c.symbol, c.text, c.lang, c.start_ln
    FROM vector v
    JOIN chunk c ON c.id = v.chunk_id
  `);

  const vecScores = allVecs.map(row => ({
    ...row,
    dist: cosineDist(queryEmbedding, row.embedding),
  }));
  vecScores.sort((a, b) => a.dist - b.dist);
  vecScores.slice(0, k * 2).forEach((r, i) => {
    results[r.chunk_id] = { ...r, rrfs: 1 / (kConst + i), rankVec: i + 1 };
  });

  // 2. FTS5 keyword search
  if (ftsQuery && ftsQuery.trim()) {
    const ft = await db.all(`
      SELECT c.id, c.path, c.symbol, c.text, c.lang, c.start_ln, rank
      FROM fts_chunk('${ftsQuery.replace(/'/g, "''")}')
      JOIN chunk c ON c.id = fts_chunk.rowid
      ORDER BY rank
      LIMIT ${k * 2}
    `);
    ft.forEach((r, i) => {
      if (results[r.id]) {
        results[r.id].rankFts = i + 1;
        results[r.id].rrf = results[r.id].rrfs + 1 / (kConst + i);
      } else {
        results[r.id] = { chunk_id: r.id, path: r.path, symbol: r.symbol, text: r.text, lang: r.lang, start_ln: r.start_ln, rankFts: i + 1, rrfs: 0, rrf: 1 / (kConst + i) };
      }
    });
  }

  // Sort by RRF score descending
  return Object.values(results)
    .sort((a, b) => (b.rrf || 0) - (a.rrf || 0))
    .slice(0, k)
    .map(r => ({
      chunkId: r.chunk_id,
      path: r.path,
      symbol: r.symbol,
      text: r.text,
      lang: r.lang,
      startLn: r.start_ln,
      rankVec: r.rankVec || null,
      rankFts: r.rankFts || null,
      rrfScore: r.rrf || 0,
    }));
}

// ─── Tiered Router ───
const FTS_PATTERN = /^(where is|find|locate|which file|symbol|class|function|let|const|import)\s+/i;
const EXPLAIN_PATTERN = /^(explain|how|what does|describe|summarize)\s+/i;
const GENERATE_PATTERN = /^(create|make|write|generate|build|add|implement)\s+/i;

export function classifyQuery(query) {
  if (FTS_PATTERN.test(query)) return 0;  // exact symbol → FTS5 only
  if (EXPLAIN_PATTERN.test(query)) return 1; // semantic → vector+RRF
  if (GENERATE_PATTERN.test(query)) return 2; // generation → B300
  return 1; // default to vector+RRF
}

// ─── File state check ───
export async function checkFileState(path, mtime, size) {
  const db = getDb();
  const row = await db.get('SELECT mtime, size, hash FROM file WHERE path = ?', path);
  if (!row) return 'new';
  if (row.mtime !== mtime || row.size !== size) return 'changed';
  return 'unchanged';
}

export async function upsertFileState(path, mtime, size, hash) {
  const db = getDb();
  await db.run(
    'INSERT OR REPLACE INTO file (path, mtime, size, hash) VALUES (?, ?, ?, ?)',
    path, mtime, size, hash
  );
}

// ─── Delete chunks for removed files ───
export async function deleteChunksForPath(path) {
  const db = getDb();
  await db.run('DELETE FROM vector WHERE chunk_id IN (SELECT id FROM chunk WHERE path = ?)', path);
  await db.run('DELETE FROM fts_chunk WHERE rowid IN (SELECT id FROM chunk WHERE path = ?)', path);
  await db.run('DELETE FROM chunk WHERE path = ?', path);
  await db.run('DELETE FROM file WHERE path = ?', path);
}

// ─── Get unembedded chunks ───
export async function getUnembeddedChunks(limit = 256) {
  const db = getDb();
  return db.all('SELECT id, hash, text, path, lang, symbol FROM chunk WHERE embedded = 0 LIMIT ?', limit);
}

// ─── Get total chunk count ───
export async function getChunkCount() {
  const db = getDb();
  const r = await db.get('SELECT COUNT(*) as c FROM chunk');
  return r.c;
}