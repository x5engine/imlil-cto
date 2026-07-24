import fs from 'fs/promises';
import path from 'path';
import Agent from './Agent.js';
import { getDb } from '../utils/db.js';
import callProvider from '../utils/providers.js';

class SupervisorAgent extends Agent {
  constructor(name, purpose, apiKey, config) {
    super(name, purpose);
    this.apiKey = apiKey;
    this.config = config;
    this.db = getDb();
  }

  async run(projectDescription) {
    console.log('Supervisor initializing...');

    // 1. Setup Environment
    const imlilDir = path.resolve('.imlil');
    await fs.mkdir(imlilDir, { recursive: true });

    // 2. Generate Detailed Plan (Markdown)
    console.log('Phase 1: Generating comprehensive plan...');
    const dateStr = new Date().toISOString().split('T')[0];
    const planFilename = `plan-${dateStr}.md`;
    const planPath = path.join(imlilDir, planFilename);

    const planContent = await this.generatePlan(projectDescription);
    await fs.writeFile(planPath, planContent);
    console.log(`  => Plan saved to ${planPath}`);

    // 3. Generate AST (JSON)
    console.log('Phase 2: Architecting file structure (AST)...');
    const ast = await this.generateAST(projectDescription, planContent);
    await fs.writeFile('ast.json', JSON.stringify(ast, null, 2));
    console.log('  => Project AST saved to ast.json');

    // 4. Generate Tasks (JSON) linked to AST
    console.log('Phase 3: Deriving actionable tasks...');
    const tasks = await this.generateTasks(planContent, ast);

    // 5. Populate Database
    console.log('Phase 4: Populating task database...');
    // Clear existing pending tasks if any (optional, but good for clean run)
    // await this.db.run('DELETE FROM tasks');

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

    // 6. Scaffold (optional but good for visual progress)
    console.log('Phase 5: Scaffolding empty files...');
    for (const filePath of Object.keys(ast)) {
      // Skip if value is null or it looks like a directory but is not needed explicitly
      const fullPath = path.resolve(filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      try {
        await fs.access(fullPath);
      } catch {
        // Only write if file doesn't exist
        if (!filePath.endsWith('/')) {
          await fs.writeFile(fullPath, '');
        }
      }
    }

    console.log('Plan ready. Execution handed off to Orchestrator.');
  }

  async callApiWithRetry(prompt, type = 'json', attempt = 1) {
    const maxRetries = 3;
    if (attempt > maxRetries) {
      throw new Error(`Failed to get valid ${type} response after ${maxRetries} attempts.`);
    }

    try {
      const response = await callProvider(prompt, { apiKey: this.apiKey });

      if (type === 'markdown') {
        return response; // No parsing needed
      }

      // JSON Parsing
      const cleanJson = (res) => {
        const startIndex = res.indexOf('{');
        const endIndex = res.lastIndexOf('}');
        if (startIndex === -1 || endIndex === -1) {
          throw new Error('Could not find JSON object in response');
        }
        return res.substring(startIndex, endIndex + 1);
      };

      return JSON.parse(cleanJson(response));
    } catch (error) {
      console.error(`Attempt ${attempt} failed: ${error.message}. Retrying...`);
      const newPrompt = `${prompt}\n\n**PREVIOUS ATTEMPT FAILED!**\nYour last response was not valid. Error: "${error.message}". \nPlease correct your output and strictly follow the format requirements.`;
      return this.callApiWithRetry(newPrompt, type, attempt + 1);
    }
  }

  async generatePlan(description) {
    const prompt = `
            You are a Senior Software Architect.
            Create a comprehensive development plan for the following request: "${description}".
            
            **REQUIREMENTS:**
            1.  **Tech Stack:** Explicitly define the technologies, libraries, and tools to be used. (e.g., React, Tailwind, Express, SQLite). Be specific.
            2.  **Conventions:** Define coding standards, naming conventions, and file organization rules.
            3.  **Architecture:** Describe the high-level architecture.
            4.  **Step-by-Step Plan:** A logical sequence of steps to implement the project.

            **OUTPUT FORMAT:**
            Return the plan as a clean, well-structured MARKDOWN string.
        `;
    return this.callApiWithRetry(prompt, 'markdown');
  }

  async generateAST(description, planContent) {
    const prompt = `
            You are a System Architect.
            Based on the project plan below, generate a complete JSON Abstract Syntax Tree (AST) representing the file structure of the project.
            
            **PLAN:**
            ${planContent}

            **REQUIREMENTS:**
            - The JSON keys must be the relative file paths (e.g., "src/index.js", "src/components/Header.js").
            - The values should be a brief description of the file's purpose.
            - Include configuration files (package.json, .gitignore, etc.).
            - Ensure the structure supports the defined tech stack.

            **OUTPUT FORMAT:**
            A single valid JSON object.
            Example:
            {
                "package.json": "Manifest",
                "src/index.js": "Entry point"
            }
        `;
    return this.callApiWithRetry(prompt, 'json');
  }

  async generateTasks(planContent, ast) {
    const astStr = JSON.stringify(ast, null, 2);
    const prompt = `
            You are a Project Manager.
            Based on the project plan and the file structure (AST), create a list of actionable CRUD tasks to build this project.
            
            **PLAN:**
            ${planContent}

            **FILE STRUCTURE (AST):**
            ${astStr}

            **REQUIREMENTS:**
            1.  **Granularity:** Each task should focus on creating or modifying specific files.
            2.  **CRUD Type:** Tasks must be clear about their action (Create, Read, Update).
            3.  **Dependencies:** Define task dependencies using IDs.
            4.  **Order:** Ensure tasks are ordered logically (e.g., setup first, then core logic, then UI).
            5.  **Parallelism:** Group independent tasks where possible to allow parallel execution by multiple agents.

            **OUTPUT FORMAT:**
            A single valid JSON object containing an array of "tasks".
            
            Required JSON Structure:
            {
                "tasks": [
                    {
                        "id": 1,
                        "title": "Initialize Project",
                        "description": "Create package.json and basic config files.",
                        "dependencies": []
                    },
                    {
                        "id": 2,
                        "title": "Create Header Component",
                        "description": "Implement src/components/Header.js based on the plan.",
                        "dependencies": [1]
                    }
                ]
            }
        `;
    const result = await this.callApiWithRetry(prompt, 'json');
    return result.tasks;
  }
}

export default SupervisorAgent;
