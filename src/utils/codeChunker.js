/**
 * codeChunker.js — tree-sitter structural chunker
 * 
 * Splits code on function/class/block boundaries, not fixed windows.
 * Prepends breadcrumb headers: path › symbol
 * 
 * Handles: JS, TS, JSX, TSX, Python, Rust, Go, HTML, CSS, JSON, YAML, Markdown, Shell
 * Falls back to line-based chunking for unknown languages.
 */

import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
// import TypeScript from 'tree-sitter-typescript'; // optional, adds weight
import { hashText } from './hash.js';

const parser = new Parser();
parser.setLanguage(JavaScript);

// ─── Language detection ───
const LANG_MAP = {
  '.js':   'javascript',
  '.jsx':  'javascript',
  '.ts':   'typescript',
  '.tsx':  'typescript',
  '.mjs':  'javascript',
  '.cjs':  'javascript',
  '.py':   'python',
  '.rs':   'rust',
  '.go':   'go',
  '.html': 'html',
  '.css':  'css',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml':  'yaml',
  '.md':   'markdown',
  '.sh':   'shell',
  '.bash': 'shell',
  '.zsh':  'shell',
};

function detectLang(filePath) {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return LANG_MAP[ext] || 'unknown';
}

// ─── Node types that form structural boundaries ───
const STRUCTURAL_NODES = new Set([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'generator_function',
  'class_declaration',
  'export_statement',
  'lexical_declaration',
  'variable_declaration',
  'module_item',
]);

function isStructural(node) {
  return STRUCTURAL_NODES.has(node.type);
}

// ─── Breadcrumb header ───
function breadcrumb(path, symbol, lang) {
  let header = `// ${path}`;
  if (symbol) header += ` › ${symbol}`;
  header += '\n';
  return header;
}

// ─── Extract symbol name from AST node ───
function nodeSymbol(node) {
  if (!node) return null;
  // function_declaration → name child
  const nameChild = node.childForFieldName('name')
    || node.childForFieldName('declarator')?.childForFieldName('name');
  if (nameChild) return nameChild.text;
  // class_declaration
  if (node.type === 'class_declaration') {
    const n = node.childForFieldName('name');
    if (n) return n.text;
  }
  // export_statement: extract child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (isStructural(child)) return nodeSymbol(child);
  }
  return null;
}

// ─── Main chunker ───
export function chunkFile(filePath, code) {
  const lang = detectLang(filePath);
  const chunks = [];

  if (lang === 'javascript' || lang === 'typescript') {
    try {
      const tree = parser.parse(code);
      const root = tree.rootNode;

      // Walk all structural nodes
      function walk(node) {
        if (isStructural(node)) {
          const symbol = nodeSymbol(node);
          const header = breadcrumb(filePath, symbol, lang);
          const body = node.text;
          const fullText = header + body;
          const startLn = node.startPosition.row + 1; // 1-indexed
          const endLn = node.endPosition.row + 1;

          chunks.push({
            path: filePath,
            lang,
            symbol,
            startLn,
            endLn,
            text: fullText,
            hash: hashText(fullText),
          });

          // Don't recurse into children — structural nodes are the leaves
          return;
        }

        // Recurse into children for top-level statements
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i));
        }
      }

      walk(root);

      // If no structural nodes found, fall back to file-level chunk
      if (chunks.length === 0) {
        const header = breadcrumb(filePath, null, lang);
        const fullText = header + code;
        chunks.push({
          path: filePath,
          lang,
          symbol: null,
          startLn: 1,
          endLn: code.split('\n').length,
          text: fullText,
          hash: hashText(fullText),
        });
      }
    } catch (e) {
      // Parser error — fall back to line-based
      return fallbackChunks(filePath, code, lang);
    }
  } else {
    // Non-JS languages — fallback
    return fallbackChunks(filePath, code, lang);
  }

  return chunks;
}

// ─── Fallback: line-based chunking for non-JS ───
function fallbackChunks(filePath, code, lang) {
  const chunks = [];
  const lines = code.split('\n');
  const MAX_CHUNK = 80; // lines per chunk
  const OVERLAP = 2;

  for (let i = 0; i < lines.length; i += MAX_CHUNK - OVERLAP) {
    const end = Math.min(i + MAX_CHUNK, lines.length);
    const body = lines.slice(i, end).join('\n');
    const header = breadcrumb(filePath, null, lang);
    const fullText = header + body;

    chunks.push({
      path: filePath,
      lang,
      symbol: null,
      startLn: i + 1,
      endLn: end,
      text: fullText,
      hash: hashText(fullText),
    });

    if (end >= lines.length) break;
  }

  return chunks;
}

// ─── Incremental scan: walk dir, stat files, return new/changed ───
export async function scanProject(projectRoot, { vectorDb, gitDiff = false } = {}) {
  const fs = await import('fs/promises');
  const path = await import('path');
  const { execSync } = await import('child_process');

  const changedFiles = []; // { path, mtime, size, code? }
  const deletedFiles = [];
  const IGNORE = new Set(['node_modules', '.git', '.imlil', '.next', 'dist', 'build', '.cache', 'coverage']);

  // Git diff fast path
  if (gitDiff) {
    try {
      const output = execSync('git diff --name-only HEAD 2>/dev/null || git diff --name-only 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
      const files = output.trim().split('\n').filter(Boolean);
      for (const f of files) {
        try {
          const stat = await fs.stat(path.join(projectRoot, f));
          changedFiles.push({ path: f, mtime: stat.mtimeMs, size: stat.size });
        } catch {
          deletedFiles.push(f);
        }
      }
      return { changedFiles, deletedFiles };
    } catch {}
  }

  // Full walk (slow path)
  const walk = async (dir, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORE.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        const relPath = path.relative(projectRoot, full);
        const state = vectorDb
          ? await vectorDb.checkFileState(relPath, stat.mtimeMs, stat.size)
          : 'unknown';
        if (state === 'new' || state === 'changed') {
          changedFiles.push({ path: relPath, mtime: stat.mtimeMs, size: stat.size });
        }
      }
    }
  };

  await walk(projectRoot);
  return { changedFiles, deletedFiles };
}