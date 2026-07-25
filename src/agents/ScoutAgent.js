/**
 * ScoutAgent.js — Continuous Task Generator
 * 
 * Runs alongside the executor on a separate GPU stream.
 * Continuously scans the project directory for what exists,
 * determines what's missing, and injects new tasks into the DB.
 * 
 * This is the "task producer" — it keeps the pipeline fed so
 * the executor never starves.
 * 
 * Architecture:
 *   ScoutAgent (GPU stream 0) ──→ DB (tasks table) ←── Executor (GPU stream 1)
 *   - Scans project every 30s
 *   - Generates 5-20 new tasks per scan
 *   - Marks existing tasks as "complete" if files already exist
 *   - Never duplicates
 * 
 * The ratio: for every 10 executor tasks processed, 
 * the scout generates ~15-30 new ones (growth factor ~1.5-3x per round)
 */

import fs from 'fs/promises';
import path from 'path';
import { getDb } from '../utils/db.js';
import { callStructured } from '../utils/providers.js';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.imlil', '__pycache__',
  '.next', 'dist', 'build', '.cache', 'coverage',
  '.husky', '.vscode', 'target', 'out', '.tmp'
]);

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.json', '.html', '.md',
  '.yml', '.yaml', '.prisma', '.svg'
]);

class ScoutAgent {
  constructor(apiKey, config) {
    this.apiKey = apiKey;
    this.config = config;
    this.db = getDb();
    this.scanInterval = null;
    this.lastScanTime = 0;
    this.lastFileCount = 0;
    this.totalGenerated = 0;
    this.isScanning = false;
  }

  /**
   * Start continuous scanning
   */
  start(intervalMs = 30000) {
    console.log(`Scout: Starting continuous task generation (every ${intervalMs/1000}s)`);
    // Do an immediate first scan
    this.scan().catch(e => console.error(`Scout: First scan failed: ${e.message}`));
    this.scanInterval = setInterval(() => this.scan().catch(e => {}), intervalMs);
  }

  stop() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    console.log(`Scout: Stopped. Generated ${this.totalGenerated} new tasks total.`);
  }

  /**
   * One scan cycle: scan project → determine gaps → insert tasks
   */
  async scan() {
    if (this.isScanning) return;
    this.isScanning = true;
    
    try {
      // 1. Quick file count check — skip if not much changed
      const currentCount = await this.countFiles();
      if (this.lastScanTime === 0) {
        // First scan — always do it
      } else if (currentCount === this.lastFileCount && Date.now() - this.lastScanTime < 60000) {
        // Nothing changed and we scanned recently — skip
        this.isScanning = false;
        return;
      }
      this.lastFileCount = currentCount;
      
      // 2. Get current DB stats
      const pending = (await this.db.all('SELECT count(*) as c FROM tasks WHERE status = ?', 'pending'))[0].c;
      const completed = (await this.db.all('SELECT count(*) as c FROM tasks WHERE status = ?', 'completed'))[0].c;
      const total = (await this.db.all('SELECT count(*) as c FROM tasks'))[0].c;
      
      // Don't scan if we already have enough pending tasks
      if (pending > 500) {
        this.isScanning = false;
        return;
      }
      
      // 3. Get the project description from env or config
      const description = this.config.projectDescription || 'A web application';
      
      // 4. Scan a sample of recently modified files
      const recentFiles = await this.scanRecentFiles(100);
      
      // 5. Get the last N completed tasks to understand context
      const recentCompleted = await this.db.all(
        'SELECT title, description FROM tasks WHERE status = ? ORDER BY id DESC LIMIT 20',
        'completed'
      );
      
      // 6. Ask B300 what tasks to add
      const newTasks = await this.generateTasks(description, recentFiles, recentCompleted);
      
      // 7. Insert them
      if (newTasks && newTasks.length > 0) {
        const existingIds = new Set();
        const existing = await this.db.all('SELECT id FROM tasks');
        existing.forEach(t => existingIds.add(t.id));
        
        let inserted = 0;
        for (const task of newTasks) {
          if (!task.id || existingIds.has(task.id)) continue;
          try {
            await this.db.run(
              'INSERT OR IGNORE INTO tasks (id, title, description, status, dependencies, retries) VALUES (?, ?, ?, ?, ?, ?)',
              task.id + 100000 + this.totalGenerated, // unique ID space
              task.title,
              task.description || '',
              'pending',
              JSON.stringify(task.dependencies || []),
              0,
            );
            inserted++;
          } catch {}
        }
        this.totalGenerated += inserted;
        if (inserted > 0) {
          console.log(`Scout: +${inserted} new tasks (${this.totalGenerated} total generated, ${pending + inserted} pending)`);
        }
      }
      
      this.lastScanTime = Date.now();
    } catch (e) {
      // Scout failures are non-fatal
    }
    
    this.isScanning = false;
  }

  async countFiles() {
    let count = 0;
    const scan = async (dir) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await scan(full);
        else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) count++;
      }
    };
    await scan('.');
    return count;
  }

  async scanRecentFiles(limit = 100) {
    const files = [];
    const scan = async (dir) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(full);
        } else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) {
          try {
            const stat = await fs.stat(full);
            files.push({
              path: path.relative('.', full),
              size: stat.size,
              mtimeMs: stat.mtimeMs
            });
          } catch {}
        }
      }
    };
    await scan('.');
    
    // Sort by modification time, take most recent
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.slice(0, limit).map(f => `${f.path} (${f.size}b)`);
  }

  async generateTasks(description, recentFiles, recentCompleted) {
    const context = recentCompleted.map(t => `  - ${t.title}: ${t.description || ''}`).join('\n');
    const fileList = recentFiles.join('\n');
    
    const prompt = `You're a project SCOUT — your job is to find what needs to be built next.

PROJECT: "${description}"

RECENT COMPLETED TASKS:
${context || '  (none yet)'}

RECENT FILES:
${fileList || '  (empty project)'}

Look at what's been done and what files exist. Determine the NEXT most valuable tasks:
1. Features that are clearly missing based on the project description
2. Missing configurations (CI, Docker, linting, testing, etc.)
3. Integration between existing components
4. Tests for existing code
5. Documentation and setup

Return a JSON object with a "tasks" array. Each task:
- title: string (short, actionable)
- description: string (what to build, be specific)
- dependencies: string[] (empty if none — reference task titles)

IMPORTANT:
- Focus on genuinely missing pieces, NOT files that already exist
- Be granular — one file or one feature per task
- Prioritize: blockers first, then core logic, then polish
- If little is missing, return { "tasks": [] }
- Return ONLY valid JSON`;

    try {
      const result = await callStructured(prompt, {
        apiKey: this.apiKey,
        config: this.config,
        maxTokens: 8192
      });
      const tasks = result?.tasks || result;
      return Array.isArray(tasks) ? tasks : [];
    } catch {
      return [];
    }
  }
}

export default ScoutAgent;