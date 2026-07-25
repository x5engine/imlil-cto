/**
 * CodeIndex.js — Incremental code index with hybrid retrieval.
 * 
 * Indexes the project using tree-sitter structural chunking.
 * Stores vectors as BLOBs in SQLite, does brute-force cosine + FTS5 RRF.
 * Runs the embedder sidecar on the 3070 Ti (fp16, batched).
 * 
 * Key design:
 *   - Hash-based chunk cache: edit one fn → re-embed one chunk
 *   - stat-based file skip: unchanged files cost nothing
 *   - git diff fast path for branch switches
 *   - chokidar watch for live updates
 */

import { getDb } from '../db.js';
import { initVectorDb, insertChunk, insertVectors, hybridSearch, classifyQuery,
         checkFileState, upsertFileState, deleteChunksForPath, getUnembeddedChunks,
         getChunkCount } from './vectorDb.js';
import { chunkFile, scanProject } from './codeChunker.js';
import { embed, healthCheck } from './embed.js';

class CodeIndex {
  constructor(config = {}) {
    this.projectRoot = config.projectRoot || process.cwd();
    this.embedBatchSize = config.embedBatchSize || 64;
    this.embedTimeout = config.embedTimeout || 30000;
    this.serverUrl = config.embedServerUrl || process.env.EMBED_SERVER_URL || 'http://100.114.42.73:8743';
    this.initialized = false;
    this.serverReady = false;
    this.totalChunks = 0;
    this.totalEmbedded = 0;
  }

  async init() {
    await initVectorDb();
    this.initialized = true;

    // Check embed server
    this.serverReady = await healthCheck();
    if (!this.serverReady) {
      console.log('⚠ Embed server not reachable — index will store chunks without vectors (fallback to FTS5-only)');
    }

    this.totalChunks = await getChunkCount();
    console.log(`📚 CodeIndex: ${this.totalChunks} existing chunks, server=${this.serverReady ? '✅' : '❌'}`);
    return this;
  }

  /**
   * Full index rebuild — walks the entire project, chunks everything, embeds all.
   */
  async rebuild() {
    console.log(`🔥 CodeIndex: Full rebuild from ${this.projectRoot}`);
    const { changedFiles } = await scanProject(this.projectRoot, { gitDiff: false });
    console.log(`  Found ${changedFiles.length} total files`);

    let newChunks = 0;
    for (let i = 0; i < changedFiles.length; i++) {
      const f = changedFiles[i];
      try {
        const fs = await import('fs/promises');
        const code = await fs.readFile(f.path, 'utf-8');
        const chunks = chunkFile(f.path, code);
        for (const chunk of chunks) {
          const row = await insertChunk(chunk);
          if (row) {  // null if already existed
            newChunks++;
            if (row.embedded) this.totalEmbedded++;
          }
        }
        await upsertFileState(f.path, f.mtime, f.size, null);
      } catch (e) {
        // skip unreadable files
      }
    }
    console.log(`  Chunked ${newChunks} new chunks`);

    // Embed unembedded
    await this.embedPending();

    this.totalChunks = await getChunkCount();
    console.log(`📚 CodeIndex: ${this.totalChunks} chunks, ${this.totalEmbedded} embedded`);
    return this;
  }

  /**
   * Incremental update — scan for changed/deleted files, update only what's needed.
   */
  async update(gitDiff = true) {
    if (!this.initialized) await this.init();

    const { changedFiles, deletedFiles } = await scanProject(this.projectRoot, { gitDiff });

    let newChunks = 0;

    // Handle deletions
    for (const path of deletedFiles) {
      await deleteChunksForPath(path);
    }

    // Handle additions/changes
    for (const f of changedFiles) {
      try {
        const fs = await import('fs/promises');
        const code = await fs.readFile(f.path, 'utf-8');

        // Delete old chunks for this file (re-chunk from scratch on change)
        if (f.mtime) await deleteChunksForPath(f.path);

        const chunks = chunkFile(f.path, code);
        for (const chunk of chunks) {
          const row = await insertChunk(chunk);
          if (row) newChunks++;
        }
        await upsertFileState(f.path, f.mtime, f.size, null);
      } catch {}
    }

    if (newChunks > 0) {
      const embedded = await this.embedPending();
      console.log(`📚 CodeIndex: +${newChunks} chunks (${embedded} embedded), ${deletedFiles.length} deleted`);
    }

    this.totalChunks = await getChunkCount();
    return { newChunks, deleted: deletedFiles.length };
  }

  /**
   * Embed all unembedded chunks in batches on the 3070 Ti.
   */
  async embedPending(batchSize = this.embedBatchSize) {
    if (!this.serverReady) return 0;

    const pending = await getUnembeddedChunks(256);
    if (pending.length === 0) return 0;

    const texts = pending.map(c => c.text);
    const embeddings = await embed(texts, { batchSize: this.embedBatchSize, timeout: this.embedTimeout });

    if (embeddings.length === 0) return 0;

    const vecRows = pending.slice(0, embeddings.length).map((chunk, i) => ({
      id: chunk.id,
      embedding: embeddings[i],
    }));

    await insertVectors(vecRows);
    this.totalEmbedded += vecRows.length;
    return vecRows.length;
  }

  /**
   * Hybrid search — vector + FTS5 with RRF fusion.
   */
  async search(query, opts = {}) {
    if (!this.initialized) await this.init();

    const tier = classifyQuery(query);
    const topK = opts.topK || 10;

    // Tier 0: FTS5 only — no embedding, no HTTP
    if (tier === 0) {
      const db = getDb();
      const ft = await db.all(`
        SELECT c.id, c.path, c.symbol, c.text, c.lang, c.start_ln
        FROM fts_chunk('${query.replace(/'/g, "''")}')
        JOIN chunk c ON c.id = fts_chunk.id
        ORDER BY rank
        LIMIT ${topK}
      `);
      return { results: ft, tier: 0, engine: 'FTS5' };
    }

    // Tier 1: Vector + RRF
    if (tier === 1) {
      if (!this.serverReady) {
        // Fallback to FTS5
        return { results: await this.search(query, { ...opts, forceFts: true }), tier: 1, engine: 'FTS5-only' };
      }

      const queryEmb = await embed([`query: ${query}`]);
      if (!queryEmb[0]) {
        return { results: [], tier: 1, engine: 'fallback' };
      }

      const results = await hybridSearch(queryEmb[0], query, { topK });
      return { results, tier: 1, engine: 'vector+RRF' };
    }

    // Tier 2: B300 call — return empty results, caller handles it
    return { results: [], tier: 2, engine: 'b300' };
  }

  /**
   * Start file watcher for live updates (chokidar).
   */
  async watch() {
    try {
      const chokidar = await import('chokidar');
      let updateTimer = null;

      chokidar.watch(this.projectRoot, {
        ignored: /(node_modules|\.git|\.imlil|dist|build|\.cache)/,
        persistent: true,
        ignoreInitial: true,
      })
      .on('change', async (filePath) => {
        console.log(`📡 File changed: ${filePath}`);
        clearTimeout(updateTimer);
        updateTimer = setTimeout(() => this.update(true).catch(() => {}), 2000);
      })
      .on('add', async (filePath) => {
        console.log(`📡 File added: ${filePath}`);
        clearTimeout(updateTimer);
        updateTimer = setTimeout(() => this.update(true).catch(() => {}), 2000);
      })
      .on('unlink', async (filePath) => {
        console.log(`📡 File deleted: ${filePath}`);
        clearTimeout(updateTimer);
        updateTimer = setTimeout(() => this.update(true).catch(() => {}), 2000);
      });

      console.log('📡 CodeIndex watcher active (2s debounce)');
    } catch (e) {
      console.log('⚠ chokidar not available — watch disabled');
    }
  }

  /**
   * Get index stats.
   */
  async stats() {
    if (!this.initialized) await this.init();
    return {
      chunks: this.totalChunks || await getChunkCount(),
      embedded: this.totalEmbedded,
      serverReady: this.serverReady,
    };
  }
}

export default CodeIndex;