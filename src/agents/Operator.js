import Agent from './Agent.js';
import callEmbedApi from '../utils/embedapi.js';
import { getDb } from '../utils/db.js';

class Operator extends Agent {
  constructor(name, purpose, aiModel, apiKey) {
    super(name, purpose);
    this.aiModel = aiModel;
    this.apiKey = apiKey;
    this.db = getDb();
    this.currentTask = null;
  }

  async generateStructure(objective) {
    console.log(`Operator designing file structure for: ${objective}`);
    const structurePrompt = `
            **CRITICAL: YOUR RESPONSE MUST BE A VALID JSON OBJECT AND NOTHING ELSE.**
            
            Based on the objective: "${objective}", design a file structure for the project.
            Return a JSON object where keys are file paths (relative to root) and values are brief descriptions of content (or null for empty files).
            Directories are implied by the paths.
            
            Example:
            {
                "src/index.js": "Entry point",
                "src/components/Header.js": "Header component",
                "src/utils/helpers.js": "Helper functions",
                "package.json": "Project manifest"
            }
        `;

    const response = await callEmbedApi(structurePrompt, this.apiKey);
    try {
      let parsableJson;
      if (response.trim().startsWith('{')) {
        const startIndex = response.indexOf('{');
        const endIndex = response.lastIndexOf('}');
        parsableJson = response.substring(startIndex, endIndex + 1);
      } else {
        throw new Error('Response is not a JSON object');
      }
      return JSON.parse(parsableJson);
    } catch (error) {
      console.error('Error parsing structure JSON:', error);
      return {}; // Fallback to empty if failed
    }
  }

  async run(objective) {
    console.log(`Operator planning for objective: ${objective}`);
    const planningPrompt = `
            **CRITICAL: YOUR RESPONSE MUST BE A VALID JSON OBJECT AND NOTHING ELSE.**
            
            Generate a project plan for the objective: "${objective}".
            
            **ARCHITECTURAL REQUIREMENT: MAXIMUM PARALLELISM**
            - The goal is to have multiple agents working at the same time.
            - **Minimize dependencies.** Only use dependencies when strictly necessary.
            - Break the project into independent components/modules.

            **REQUIRED JSON STRUCTURE:**
            {
                "blueprint": {
                    "fileStructure": "Description of the directory structure (e.g., src/components, src/utils)",
                    "conventions": "Naming conventions (e.g., PascalCase for components), testing conventions (e.g., place tests in __tests__ folder)",
                    "techStack": "List of key technologies (e.g., React, Jest, CSS Modules)"
                },
                "tasks": [
                    {
                        "id": 1, 
                        "title": "Task Title", 
                        "description": "Task Description", 
                        "status": "pending", 
                        "dependencies": []
                    }
                ]
            }
        `;
    const planJson = await callEmbedApi(planningPrompt, this.apiKey);
    if (planJson) {
      try {
        let parsableJson;
        if (planJson.trim().startsWith('{')) {
          const startIndex = planJson.indexOf('{');
          const endIndex = planJson.lastIndexOf('}');
          parsableJson = planJson.substring(startIndex, endIndex + 1);
        } else {
          throw new Error('Response is not a JSON object');
        }

        const planData = JSON.parse(parsableJson);
        const { tasks } = planData;
        const { blueprint } = planData;

        const planId = this.id;

        for (const task of tasks) {
          await this.db.run(
            'INSERT INTO tasks (id, title, description, status, dependencies) VALUES (?, ?, ?, ?, ?)',
            task.id,
            task.title,
            task.description,
            'pending',
            JSON.stringify(task.dependencies),
          );
        }

        console.log(`Plan saved to database with ${tasks.length} tasks.`);
        return { planId, plan: { tasks, blueprint } };
      } catch (error) {
        console.error('Error parsing JSON plan from API:', error);
        console.error('Received raw API response (expected pure JSON):', planJson);
        throw error;
      }
    }
    throw new Error('Failed to get a plan from the AI model.');
  }

  async assignTask(task) {
    this.currentTask = task;
    await this.db.run('UPDATE tasks SET status = ? WHERE id = ?', 'assigned', task.id);
    this.start();
  }

  async start() {
    console.log(`Operator ${this.name} starting task: ${this.currentTask.title}`);
    await this.executeTask();
    console.log(`Operator ${this.name} finished task: ${this.currentTask.title}`);
  }

  async executeTask() {
    if (!this.currentTask) {
      throw new Error('No task assigned');
    }

    try {
      await this.db.run('UPDATE tasks SET status = ? WHERE id = ?', 'running', this.currentTask.id);
      // AI execution logic will be in the worker
      await this.db.run('UPDATE tasks SET status = ? WHERE id = ?', 'completed', this.currentTask.id);
    } catch (error) {
      await this.db.run('UPDATE tasks SET status = ? WHERE id = ?', 'failed', this.currentTask.id);
      throw error;
    }
  }
}

export default Operator;
