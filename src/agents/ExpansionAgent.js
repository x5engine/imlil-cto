import Agent from './Agent.js';
import { getDb } from '../utils/db.js';
import { callStructured } from '../utils/providers.js';

/**
 * ExpansionAgent — the "Scout Planner"
 *
 * Watches for completed tasks and immediately generates follow-up work:
 * - Edge cases uncovered by implementation
 * - Missing tests, documentation, error handling
 * - Performance optimizations
 * - Adjacent features that the completed task enables
 * - Refactoring opportunities
 *
 * This keeps the 1000-agent army fed with infinite work.
 * The project gets deeper, not just wider.
 */
class ExpansionAgent extends Agent {
  constructor(apiKey, config) {
    super('ExpansionPlanner', 'Generates follow-up tasks from completed work');
    this.apiKey = apiKey;
    this.config = config;
    this.db = getDb();
    this.processedTasks = new Set();
  }

  /**
   * Process a just-completed task and generate expansion tasks.
   * Called by the orchestrator after validation passes.
   */
  async expandFrom(task, codePath, testPath) {
    if (this.processedTasks.has(task.id)) return [];
    this.processedTasks.add(task.id);

    // Read the generated code for context
    let codeContent = '';
    try {
      const fs = await import('fs/promises');
      if (codePath) {
        codeContent = (await fs.readFile(codePath, 'utf8')).slice(0, 3000);
      }
    } catch { /* no file yet */ }

    const prompt = `A task was just completed in this project. Based on the implementation, what follow-up work would improve the project?

COMPLETED TASK: ${task.title}
DESCRIPTION: ${task.description}
IMPLEMENTATION (first 3000 chars):
${codeContent}

Generate 0-3 follow-up tasks that:
- Fill in missing functionality (error handling, edge cases, validation)
- Add tests for uncovered scenarios
- Improve documentation or type definitions
- Refactor or optimize
- Extend the feature with adjacent capabilities

Return a JSON object with a "tasks" array. Each task has:
- title: string
- description: string
- priority: "low" | "medium" | "high"

Only generate tasks that genuinely improve the project. Return empty array if no expansion is needed.`;

    try {
      const result = await callStructured(prompt, { apiKey: this.apiKey, maxTokens: 2048 });
      const newTasks = result?.tasks || [];

      const added = [];
      for (const t of newTasks) {
        const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const deps = [task.id];

        await this.db.run(
          'INSERT INTO tasks (id, title, description, status, dependencies, retries) VALUES (?, ?, ?, ?, ?, ?)',
          id,
          t.title,
          t.description || `Follow-up from: ${task.title}`,
          'pending',
          JSON.stringify(deps),
          0,
        );
        added.push(id);
      }

      if (added.length > 0) {
        console.log(`ExpansionPlanner: Generated ${added.length} follow-up tasks from "${task.title}"`);
      }
      return added;
    } catch (error) {
      console.error(`ExpansionPlanner: Failed to expand from "${task.title}": ${error.message}`);
      return [];
    }
  }
}

export default ExpansionAgent;