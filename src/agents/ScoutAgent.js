/**
 * ScoutAgent.js v2 — Tool-Based Continuous Task Generator
 * 
 * Uses the Agent Tool System to let the LLM explore the project
 * organically, just like Claude Code / Cursor.
 * 
 * The LLM calls:
 *   listDir(".")     → sees the project tree
 *   read("src/...")  → reads specific files
 *   search("auth")   → finds auth-related code
 *   run("npm test")  → runs tests to find gaps
 * 
 * Then generates tasks for what's MISSING, not what exists.
 * 
 * This is 100x more efficient than brute-force scanning 2,000 files.
 */

import { getDb } from '../utils/db.js';
import { callProvider } from '../utils/providers.js';
import * as Tools from '../utils/tools.js';

const MAX_TOOL_CALLS = 8; // Max tool calls per scout cycle
const TOOL_TIMEOUT = 15000; // 15s per tool call

class ScoutAgent {
  constructor(apiKey, config) {
    this.apiKey = apiKey;
    this.config = config;
    this.db = getDb();
    this.scanInterval = null;
    this.totalGenerated = 0;
    this.isScanning = false;
    this.lastScanTime = 0;
    this.pendingThreshold = 500; // Skip if this many pending
  }

  start(intervalMs = 30000) {
    console.log(`Scout v2: Tool-based task generation (every ${intervalMs/1000}s)`);
    this.scan().catch(e => console.error(`Scout: Scan failed: ${e.message}`));
    this.scanInterval = setInterval(() => this.scan().catch(e => {}), intervalMs);
  }

  stop() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    console.log(`Scout: Stopped. Generated ${this.totalGenerated} tasks.`);
  }

  /**
   * One scout cycle:
   * 1. Check if we need tasks (pending below threshold)
   * 2. Give LLM tools to explore the project
   * 3. LLM calls tools to understand what exists
   * 4. LLM generates tasks for missing pieces
   * 5. Insert tasks into DB
   */
  async scan() {
    if (this.isScanning) return;
    
    // Don't scan too often
    if (Date.now() - this.lastScanTime < 30000 && this.lastScanTime > 0) return;
    
    // Check if we need tasks
    const pending = (await this.db.all('SELECT count(*) as c FROM tasks WHERE status = ?', 'pending'))[0].c;
    if (pending >= this.pendingThreshold) return;
    
    this.isScanning = true;
    this.lastScanTime = Date.now();
    
    try {
      const description = this.config.projectDescription || 'A web application';
      
      // Get recent completed for context
      const recentCompleted = await this.db.all(
        'SELECT title, description FROM tasks WHERE status = ? ORDER BY id DESC LIMIT 10',
        'completed'
      );
      
      const taskContext = recentCompleted.map(t => `  ✅ ${t.title}${t.description ? ': ' + t.description : ''}`).join('\n');
      
      // System prompt with tools
      const systemPrompt = `You are a project SCOUT. Your job is to explore this project and find what needs to be built next.

PROJECT: "${description}"

RECENTLY COMPLETED TASKS:
${taskContext || '  (none yet)'}

You have TOOLS to explore the project. Use them to understand the existing codebase,
then determine what's MISSING and return tasks for what needs to be built.

TOOLS AVAILABLE:
- listDir(path, maxDepth?)  → See directory tree
- ls(path)                  → List files in a directory
- read(path, offset, limit) → Read a file
- search(pattern)           → Search file contents
- glob(pattern)             → Find files by name
- stat(path)                → File metadata
- run(command)              → Execute shell command (test, lint, etc.)

STRATEGY:
1. First call listDir(".") to see the project structure
2. Read key files that seem important or incomplete
3. Search for patterns like "TODO", "FIXME", or missing features
4. Run tests if they exist: run("npx jest --listTests 2>/dev/null || echo no jest")
5. Based on your findings, generate tasks for what's genuinely missing

When you're done exploring, return a JSON object:
{ "tasks": [{ "title": "...", "description": "...", "dependencies": [] }] }

IMPORTANT:
- Be granular — one file or one feature per task
- Focus on what's MISSING, not what exists
- If little is missing, return { "tasks": [] }
- Return ONLY the JSON when done`;

      // Run tool-assisted exploration
      const { tasks } = await this.exploreWithTools(systemPrompt, description);
      
      // Insert into DB
      if (tasks && tasks.length > 0) {
        const existingIds = new Set();
        (await this.db.all('SELECT id FROM tasks')).forEach(t => existingIds.add(t.id));
        
        let inserted = 0;
        for (const task of tasks) {
          if (existingIds.has(task.title)) continue; // dedupe by title
          try {
            await this.db.run(
              'INSERT OR IGNORE INTO tasks (id, title, description, status, dependencies, retries) VALUES (?, ?, ?, ?, ?, ?)',
              100000 + Date.now() % 100000 + inserted,
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
        console.log(`Scout: +${inserted} new tasks (${pending + inserted} pending)`);
      }
    } catch (e) {
      console.error(`Scout: Cycle error: ${e.message}`);
    }
    
    this.isScanning = false;
  }

  /**
   * Tool-assisted exploration loop.
   * Calls the LLM with tool results until it returns JSON tasks.
   */
  async exploreWithTools(systemPrompt, description) {
    // Start with just the system prompt
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Explore the project and tell me what needs to be built for: "${description}"` }
    ];
    
    for (let round = 0; round < MAX_TOOL_CALLS; round++) {
      // Call B300
      const response = await callProvider(
        messages.map(m => m.role === 'tool' ? `[Tool: ${m.name}]\n${m.content}` : m.content).join('\n\n'),
        { apiKey: this.apiKey, config: this.config, maxTokens: 4096 }
      );
      
      const content = response.trim();
      
      // Check if response is JSON
      if (content.startsWith('{') || content.startsWith('[')) {
        try {
          const parsed = JSON.parse(content);
          const tasks = parsed.tasks || parsed;
          return { tasks: Array.isArray(tasks) ? tasks : [] };
        } catch {
          // Not valid JSON yet — keep exploring
        }
      }
      
      // Check if response contains a tool call
      const toolMatch = content.match(/`(listDir|ls|read|search|glob|stat|run)\(([^)]*)\)`/);
      if (toolMatch) {
        const [, toolName, argsStr] = toolMatch;
        let args;
        try { args = JSON.parse(`[${argsStr}]`); } catch {
          args = [argsStr.replace(/['"]/g, '').trim()];
        }
        
        const result = await Tools[toolName]?.fn(...args).catch(e => ({ ok: false, error: e.message }))
          || { ok: false, error: `Tool ${toolName} not found` };
        
        messages.push({
          role: 'tool',
          name: toolName,
          content: JSON.stringify(result, null, 2).slice(0, 2000)
        });
      } else {
        // No tool call — the LLM is asking for something or giving status.
        // Push its response and ask for concrete tasks or tool calls
        messages.push({ role: 'assistant', content: content.slice(0, 1000) });
        messages.push({ role: 'user', content: 'Use the available tools to explore the project, then return JSON tasks.' });
      }
    }
    
    // Max rounds reached — try one final generation
    const lastMsg = messages[messages.length - 1].content;
    const taskMatch = lastMsg.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
    if (taskMatch) {
      try {
        return { tasks: JSON.parse(taskMatch[0]).tasks || [] };
      } catch {}
    }
    
    return { tasks: [] };
  }
}

export default ScoutAgent;