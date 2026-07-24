import fs from 'fs/promises';
import path from 'path';
import Agent from './Agent.js';
import { getDb } from '../utils/db.js';
import callProvider from '../utils/providers.js';
import { callStructured } from '../utils/providers.js';

class SupervisorAgent extends Agent {
  constructor(name, purpose, apiKey, config) {
    super(name, purpose);
    this.apiKey = apiKey;
    this.config = config;
    this.db = getDb();
  }

  async run(projectDescription) {
    console.log('Supervisor initializing...');

    const imlilDir = path.resolve('.imlil');
    await fs.mkdir(imlilDir, { recursive: true });

    // Phase 1: Plan (markdown)
    console.log('Phase 1: Generating comprehensive plan...');
    const dateStr = new Date().toISOString().split('T')[0];
    const planPath = path.join(imlilDir, `plan-${dateStr}.md`);
    const planContent = await this.generatePlan(projectDescription);
    await fs.writeFile(planPath, planContent);
    console.log(`  => Plan saved to ${planPath}`);

    // Phase 2: AST (structured JSON)
    console.log('Phase 2: Architecting file structure (AST)...');
    const ast = await this.generateAST(projectDescription, planContent);
    await fs.writeFile('ast.json', JSON.stringify(ast, null, 2));
    console.log(`  => AST with ${Object.keys(ast).length} files saved`);

    // Phase 3: Tasks
    console.log('Phase 3: Deriving actionable tasks...');
    const tasks = await this.generateTasks(planContent, ast);
    console.log(`  => ${tasks.length} tasks generated`);

    // Phase 4: Populate DB
    console.log('Phase 4: Populating task database...');
    for (const task of tasks) {
      await this.db.run(
        'INSERT INTO tasks (id, title, description, status, dependencies, retries) VALUES (?, ?, ?, ?, ?, ?)',
        task.id,
        task.title,
        task.description,
        'pending',
        JSON.stringify(task.dependencies || []),
        0,
      );
    }
    console.log(`  => ${tasks.length} tasks queued in database.`);

    // Phase 5: Scaffold
    console.log('Phase 5: Scaffolding empty files...');
    for (const filePath of Object.keys(ast)) {
      const fullPath = path.resolve(filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      try {
        await fs.access(fullPath);
      } catch {
        if (!filePath.endsWith('/')) {
          await fs.writeFile(fullPath, '');
        }
      }
    }

    console.log('Plan ready. Execution handed off to Orchestrator.');
  }

  async withRetry(fn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        console.error(`Attempt ${i + 1} failed: ${error.message}. Retrying...`);
      }
    }
    throw new Error(`Failed after ${maxRetries} attempts`);
  }

  async generatePlan(description) {
    const prompt = `Create a comprehensive development plan for: "${description}".

Include:
1. Tech stack (exact technologies, versions)
2. Coding conventions and file organization
3. High-level architecture
4. Step-by-step implementation plan

Return as clean MARKDOWN.`;
    return this.withRetry(() => callProvider(prompt, { apiKey: this.apiKey, maxTokens: 8192 }));
  }

  async generateAST(description, planContent) {
    const prompt = `Based on the plan below, generate a JSON file structure (AST).

PLAN: ${planContent.slice(0, 3000)}

Return a JSON object where keys are file paths relative to project root.
Example: { "src/index.js": "Entry point", "package.json": "Manifest" }

Use response_format to return valid JSON.`;
    return this.withRetry(() => callStructured(prompt, { apiKey: this.apiKey, maxTokens: 8192 }));
  }

  async generateTasks(planContent, ast) {
    const astStr = JSON.stringify(ast, null, 2);
    const prompt = `Based on the project plan and file structure, create actionable tasks.

PLAN: ${planContent.slice(0, 2000)}

FILE STRUCTURE: ${astStr}

Return a JSON object with a "tasks" array. Each task has:
- id: number (unique integer)
- title: string
- description: string
- dependencies: number[] (empty array if no deps)

IMPORTANT:
- Break into granular single-file tasks
- Minimize dependencies for maximum parallelism
- Order logically (setup -> core logic -> UI -> tests)

Return valid JSON with a "tasks" array.`;
    return this.withRetry(async () => {
      const result = await callStructured(prompt, { apiKey: this.apiKey, maxTokens: 8192 });
      const tasks = result?.tasks || result;
      if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
        throw new Error(`generateTasks: expected non-empty array, got ${JSON.stringify(tasks).slice(0, 200)}`);
      }
      return tasks;
    });
  }
}

export default SupervisorAgent;