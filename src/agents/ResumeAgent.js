/**
 * ResumeAgent.js — Resume/Continue Mode
 * 
 * Instead of generating a plan + AST from scratch, this agent:
 * 1. Scans the current project directory for existing files
 * 2. Builds a "current AST" from what exists
 * 3. Sends it to B300 to determine what's missing/next
 * 4. Generates ONLY tasks for what doesn't exist yet
 * 
 * Usage: imlil make --resume|--continue "Project description"
 */

import fs from 'fs/promises';
import path from 'path';
import Agent from './Agent.js';
import { getDb } from '../utils/db.js';
import { callStructured } from '../utils/providers.js';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.imlil', '__pycache__',
  '.next', 'dist', 'build', '.cache', 'coverage',
  '.husky', '.vscode', 'target', 'out'
]);

const IGNORE_FILES = new Set([
  '.DS_Store', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml'
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.json', '.html', '.md',
  '.yml', '.yaml', '.prisma', '.env.example', '.env.sample',
  '.eslintrc.json', '.prettierrc', 'Dockerfile', '.gitignore',
  'tsconfig.json', 'vite.config.ts', 'vite.config.js'
]);

class ResumeAgent extends Agent {
  constructor(name, purpose, apiKey, config) {
    super(name, purpose);
    this.apiKey = apiKey;
    this.config = config;
    this.db = getDb();
  }

  /**
   * Scan project directory recursively, building a "current AST"
   */
  async scanProject(rootDir = '.') {
    console.log(`Resume: Scanning existing project in ${rootDir}...`);
    const existingFiles = {};
    
    const scan = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(rootDir, fullPath);
        
        if (entry.isDirectory()) {
          const dirName = entry.name;
          if (IGNORE_DIRS.has(dirName) || dirName.startsWith('.')) continue;
          existingFiles[relPath + '/'] = 'directory';
          await scan(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const baseName = path.basename(entry.name);
          if (IGNORE_FILES.has(baseName)) continue;
          // Only include source files and configs that are meaningful
          if (SOURCE_EXTENSIONS.has(ext) || SOURCE_EXTENSIONS.has(baseName)) {
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              existingFiles[relPath] = {
                path: relPath,
                size: content.length,
                lines: content.split('\n').length,
                preview: content.slice(0, 200).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // remove control chars
              };
            } catch {
              existingFiles[relPath] = { path: relPath, size: 0, lines: 0, preview: '' };
            }
          }
        }
      }
    };
    
    await scan(rootDir);
    console.log(`Resume: Found ${Object.keys(existingFiles).length} existing files/dirs.`);
    return existingFiles;
  }

  /**
   * Determine what's still needed based on existing code
   */
  async determineTasks(projectDescription, existingFiles) {
    // Build a compact summary of what exists
    const fileSummary = Object.entries(existingFiles)
      .filter(([k, v]) => typeof v === 'object' && v.size > 0)
      .map(([k, v]) => `${k} (${v.lines} lines, ${v.size} bytes)`)
      .sort()
      .slice(0, 300); // cap at 300 files to avoid token overflow

    const prompt = `I'm continuing an existing project.

PROJECT DESCRIPTION: "${projectDescription}"

EXISTING FILES (${fileSummary.length} files):
${fileSummary.join('\n')}

Your job: Determine what still needs to be built. Think about:
1. What core features are STILL MISSING based on the project description
2. What dependencies or configurations aren't in place yet
3. Logical next steps to make the project functional
4. Integration tasks between existing components

Return a JSON object with a "tasks" array. Each task:
- id: number (starting from 1)
- title: string (short, actionable)
- description: string (brief context)
- dependencies: number[] (task IDs this depends on, empty if none)

IMPORTANT:
- Focus on genuinely missing pieces, not files that already exist
- Be specific about what code needs to be written
- Break into granular single-file or single-feature tasks
- Return ONLY valid JSON with a "tasks" array
- If everything is already complete, return { "tasks": [] }`;

    const result = await callStructured(prompt, { 
      apiKey: this.apiKey, 
      config: this.config,
      maxTokens: 8192 
    });
    
    const tasks = result?.tasks || result;
    if (!tasks || !Array.isArray(tasks)) {
      console.log('Resume: No new tasks needed — project appears complete or LLM failed.');
      return [];
    }
    
    console.log(`Resume: Generated ${tasks.length} follow-up tasks.`);
    return tasks;
  }

  async run(projectDescription) {
    console.log('Resume Agent: Continuing existing project...');
    
    const imlilDir = path.resolve('.imlil');
    await fs.mkdir(imlilDir, { recursive: true });
    
    // Step 1: Scan existing project
    const existingFiles = await this.scanProject('.');
    
    // Save current AST for reference
    await fs.writeFile('ast-current.json', JSON.stringify(existingFiles, null, 2));
    console.log(`  => Current AST saved to ast-current.json`);
    
    // Step 2: Determine what's needed
    console.log('Resume: Analyzing what needs to be built...');
    const tasks = await this.determineTasks(projectDescription, existingFiles);
    
    // Step 3: Populate DB (without resetting existing completed tasks)
    const existingTaskIds = new Set();
    try {
      const existing = await this.db.all('SELECT id FROM tasks');
      existing.forEach(t => existingTaskIds.add(t.id));
    } catch {
      // DB might be fresh
    }
    
    let inserted = 0;
    for (const task of tasks) {
      if (!task.id || existingTaskIds.has(task.id)) continue;
      try {
        await this.db.run(
          'INSERT OR IGNORE INTO tasks (id, title, description, status, dependencies, retries) VALUES (?, ?, ?, ?, ?, ?)',
          task.id,
          task.title,
          task.description || '',
          'pending',
          JSON.stringify(task.dependencies || []),
          0,
        );
        inserted++;
      } catch (e) {
        // Skip duplicates
      }
    }
    
    console.log(`  => ${inserted} new tasks queued in database.`);
    console.log('Resume: Handoff to Orchestrator.');
  }
}

export default ResumeAgent;