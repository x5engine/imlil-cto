/**
 * embed.js — Batched embedder client for the 3070 Ti sidecar.
 * 
 * Batches 64-256 chunks per HTTP call to the Python embed_server.py.
 * Mostly idle (no CPU burn) because the GPU does the work.
 */

const EMBED_SERVER = process.env.EMBED_SERVER_URL || 'http://127.0.0.1:8743';

export async function embed(texts, { batchSize = 64, timeout = 30000 } = {}) {
  if (!texts || texts.length === 0) return [];

  // Batch into chunks of batchSize
  const batches = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  const allEmbeddings = [];

  for (const batch of batches) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout);

      const resp = await fetch(`${EMBED_SERVER}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: batch }),
        signal: ac.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const err = await resp.text().catch(() => 'unknown');
        console.error(`Embed server error (${resp.status}): ${err}`);
        return allEmbeddings; // return what we have
      }

      const data = await resp.json();
      for (const emb of data.embeddings) {
        allEmbeddings.push(new Float32Array(emb));
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        console.error(`Embed request timed out after ${timeout}ms`);
      } else {
        console.error(`Embed request failed: ${e.message}`);
      }
      return allEmbeddings; // return partial results
    }
  }

  return allEmbeddings;
}

/**
 * Embed a single text (convenience wrapper).
 */
export async function embedOne(text) {
  const result = await embed([text]);
  return result[0] || null;
}

/**
 * Check if embed server is alive.
 */
export async function healthCheck() {
  try {
    const resp = await fetch(`${EMBED_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}