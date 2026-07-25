/**
 * tools.js — Agent Tool System
 * 
 * The tools that Claude Code / Cursor use internally.
 * Each tool is a function an LLM agent can call.
 * Tools run in the project directory, have access to filesystem and shell.
 * 
 * Available tools:
 *   read(path, offset?, limit?)   — Read file with pagination
 *   search(pattern, path?)         — Ripgrep content search (fast)
 *   glob(pattern)                  — Find files by name pattern
 *   ls(path)                       — List directory contents
 *   stat(path)                     — File metadata
 *   run(command, timeout?)         — Execute shell command
 *   install(package)               — Install dependency
 *   listDir(path, depth?)         — Recursive limited tree
 * 
 * Each tool returns { ok: true, data: ... } or { ok: false, error: "..." }
 */

import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = process.cwd();

// ─── Security: restrict all file ops to project root ───
function resolvePath(target) {
  const resolved = path.resolve(PROJECT_ROOT, target);
  if (!resolved.startsWith(PROJECT_ROOT)) {
    throw new Error(`Path traversal blocked: "${target}" resolves outside project root`);
  }
  return resolved;
}

// ─── maxDepth helper ───
function maxDepth(p) {
  const rel = path.relative(PROJECT_ROOT, p);
  return rel.split(path.sep).filter(Boolean).length;
}

// ─── Tool 1: read ───
/**
 * Read a file with optional offset and line limit.
 * Like `readFile` in VS Code / Cursor.
 */
export async function read(targetPath, offset = 1, limit = 500) {
  try {
    const fullPath = resolvePath(targetPath);
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;
    
    if (offset > totalLines) {
      return { ok: true, data: '', offset, limit, totalLines, filePath: targetPath };
    }
    
    const startIdx = Math.max(0, offset - 1);
    const endIdx = Math.min(startIdx + limit, totalLines);
    const snippet = lines.slice(startIdx, endIdx).join('\n');
    
    return {
      ok: true,
      data: snippet,
      offset,
      limit,
      totalLines,
      filePath: targetPath,
      linesReturned: endIdx - startIdx
    };
  } catch (e) {
    return { ok: false, error: e.message, filePath: targetPath };
  }
}

// ─── Tool 2: search (ripgrep-style) ───
/**
 * Search file contents using regex.
 * Like Cmd+Shift+F in VS Code, or @codebase in Cursor.
 * Uses ripgrep if available (10-100x faster), falls back to Node walk.
 */
export async function search(pattern, searchPath = '.', { maxResults = 30, filePattern } = {}) {
  try {
    const fullPath = resolvePath(searchPath);
    const stat = await fs.stat(fullPath);
    if (!stat.isDirectory()) {
      return { ok: false, error: `Not a directory: ${searchPath}` };
    }
    
    // Try ripgrep first (blazing fast)
    try {
      const rgCmd = `rg -l -i "${pattern.replace(/"/g, '\\"')}" "${fullPath}" --glob '!node_modules/**' --glob '!.git/**' --glob '!.imlil/**' --glob '!.next/**' --glob '!dist/**' --glob '!build/**' --glob '!.cache/**' 2>/dev/null | head -${maxResults}`;
      const files = execSync(rgCmd, { timeout: 10000, encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
      
      if (files.length > 0) {
        // Ripgrep worked! Now get line-level matches for each file
        const results = [];
        for (const file of files.slice(0, 20)) { // limit to 20 files for details
          const grepCmd = `rg -n -i "${pattern.replace(/"/g, '\\"')}" "${file}" 2>/dev/null | head -5`;
          try {
            const lines = execSync(grepCmd, { timeout: 5000, encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
            for (const line of lines) {
              const match = line.match(/^(\d+):(.+)$/);
              if (match) {
                results.push({ file: path.relative(fullPath, file), line: parseInt(match[1]), content: match[2].trim().slice(0, 200) });
              }
            }
          } catch {}
        }
        return { ok: true, data: results.length > 0 ? results : files.map(f => ({ file: path.relative(fullPath, f), line: 0, content: '' })), count: results.length || files.length, pattern, engine: 'ripgrep' };
      }
    } catch {
      // ripgrep not available, fall back to Node walk
    }
    
    // Fallback: Node recursive walk (slower but always works)
    const results = [];
    const ignoreDirs = new Set(['node_modules', '.git', '.imlil', '.next', 'dist', 'build', '.cache', 'coverage', '.husky']);
    
    const walk = async (dir, depth = 0) => {
      if (depth > 6 || results.length >= maxResults) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.name.startsWith('.') || ignoreDirs.has(entry.name)) continue;
        
        const full = path.join(dir, entry.name);
        const rel = path.relative(fullPath, full);
        
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (entry.isFile()) {
          if (filePattern && !entry.name.match(filePattern)) continue;
          try {
            const content = await fs.readFile(full, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].match(new RegExp(pattern, 'i'))) {
                results.push({
                  file: rel,
                  line: i + 1,
                  content: lines[i].trim().slice(0, 200)
                });
                if (results.length >= maxResults) return;
              }
            }
          } catch { /* skip binary/unreadable */ }
        }
      }
    };
    
    await walk(fullPath);
    return { ok: true, data: results, count: results.length, pattern };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Tool 3: glob ───
/**
 * Find files by name pattern (like double-star-slash-star-dot-tsx in VS Code).
 */
export async function glob(pattern, searchPath = '.') {
  try {
    const fullPath = resolvePath(searchPath);
    const isRegex = pattern.includes('*') || pattern.includes('?');
    
    // Convert simple glob to regex
    const regex = isRegex
      ? new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
      : new RegExp(pattern, 'i');
    
    const results = [];
    const ignoreDirs = new Set(['node_modules', '.git', '.imlil', '.next', 'dist', 'build', '.cache', 'coverage']);
    
    const walk = async (dir, depth = 0) => {
      if (depth > 5 || results.length > 200) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      
      for (const entry of entries) {
        if (entry.name.startsWith('.') || ignoreDirs.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(fullPath, full);
        
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (entry.isFile() && regex.test(entry.name)) {
          const stat = await fs.stat(full);
          results.push({ file: rel, size: stat.size, modified: stat.mtimeMs });
        }
      }
    };
    
    await walk(fullPath);
    return { ok: true, data: results.sort((a, b) => b.modified - a.modified), count: results.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Tool 4: ls ───
/**
 * List directory contents (files + dirs).
 */
export async function ls(targetPath = '.') {
  try {
    const fullPath = resolvePath(targetPath);
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    
    const data = await Promise.all(entries
      .filter(e => !e.name.startsWith('.'))
      .map(async (entry) => {
        const full = path.join(fullPath, entry.name);
        let meta = { name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' };
        if (entry.isFile()) {
          try {
            const stat = await fs.stat(full);
            meta.size = stat.size;
            meta.modified = stat.mtimeMs;
          } catch { meta.size = 0; }
        }
        return meta;
      }));
    
    return { ok: true, data, path: targetPath, count: data.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Tool 5: stat ───
/**
 * Get file metadata without reading content.
 */
export async function stat(targetPath) {
  try {
    const fullPath = resolvePath(targetPath);
    const info = await fs.stat(fullPath);
    return {
      ok: true,
      data: {
        path: targetPath,
        size: info.size,
        isDirectory: info.isDirectory(),
        isFile: info.isFile(),
        created: info.birthtimeMs,
        modified: info.mtimeMs,
        accessed: info.atimeMs,
      }
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Tool 6: run ───
/**
 * Execute a shell command in the project root.
 * Timeout defaults to 30s for safety.
 */
export async function run(command, timeout = 30000) {
  try {
    const result = execSync(command, {
      cwd: PROJECT_ROOT,
      timeout,
      maxBuffer: 1024 * 1024, // 1MB output
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, data: result.trim(), command, exitCode: 0 };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      command,
      exitCode: e.status || -1,
      stdout: e.stdout?.toString().trim() || '',
      stderr: e.stderr?.toString().trim() || ''
    };
  }
}

// ─── Tool 7: install ───
/**
 * Install a package (npm, pip, apt depending on project).
 */
export async function install(packageName, manager) {
  // Auto-detect package manager
  if (!manager) {
    try {
      await fs.access(path.join(PROJECT_ROOT, 'package.json'));
      manager = 'npm';
    } catch {
      try {
        await fs.access(path.join(PROJECT_ROOT, 'pyproject.toml'));
        manager = 'pip';
      } catch {
        return { ok: false, error: 'Cannot detect package manager. No package.json or pyproject.toml found.' };
      }
    }
  }
  
  const cmd = manager === 'npm' ? `npm install ${packageName} --save` :
              manager === 'pip' ? `pip install ${packageName}` :
              `npm install ${packageName}`;
  
  try {
    const result = execSync(cmd, { cwd: PROJECT_ROOT, timeout: 120000, encoding: 'utf-8' });
    return { ok: true, data: result.trim(), command: cmd, package: packageName };
  } catch (e) {
    return { ok: false, error: e.message, command: cmd };
  }
}

// ─── Tool 8: listDir (recursive tree, limited) ───
/**
 * Get a compact tree view of the project.
 * Like `tree` command but capped at depth 3.
 */
export async function listDir(targetPath = '.', maxDepth = 3) {
  try {
    const fullPath = resolvePath(targetPath);
    const ignore = new Set(['node_modules', '.git', '.imlil', '.next', 'dist', 'build', '.cache', 'coverage', '.husky']);
    
    const tree = [];
    
    const walk = async (dir, depth = 0) => {
      if (depth > maxDepth) return;
      const indent = '  '.repeat(depth);
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      
      for (const entry of entries) {
        if (entry.name.startsWith('.') || ignore.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(fullPath, full);
        
        if (entry.isDirectory()) {
          tree.push(`${indent}📁 ${rel}/`);
          await walk(full, depth + 1);
        } else if (entry.isFile()) {
          tree.push(`${indent}📄 ${rel}`);
        }
      }
    };
    
    await walk(fullPath);
    return { ok: true, data: tree, count: tree.length, path: targetPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Registry ───
export const TOOLS = {
  read: { fn: read, description: 'Read a file with optional line offset and limit. Returns paginated content.' },
  search: { fn: search, description: 'Search file contents by regex pattern. Like ripgrep. Supports maxResults and filePattern filters.' },
  glob: { fn: glob, description: 'Find files by glob pattern (e.g. **/*.tsx). Returns metadata.' },
  ls: { fn: ls, description: 'List directory contents — files and subdirectories with metadata.' },
  stat: { fn: stat, description: 'Get file metadata (size, dates, type) without reading content.' },
  run: { fn: run, description: 'Execute a shell command with timeout. Returns stdout/stderr.' },
  install: { fn: install, description: 'Install a package via npm/pip. Auto-detects package manager.' },
  listDir: { fn: listDir, description: 'Recursive directory tree, depth-limited. Shows folder structure compactly.' },
};

/**
 * Execute a tool by name with the given args.
 * Returns the tool's result.
 */
export async function callTool(toolName, args = {}) {
  const tool = TOOLS[toolName];
  if (!tool) {
    return { ok: false, error: `Unknown tool: "${toolName}". Available: ${Object.keys(TOOLS).join(', ')}` };
  }
  try {
    return await tool.fn(...Object.values(args));
  } catch (e) {
    return { ok: false, error: `Tool "${toolName}" error: ${e.message}` };
  }
}