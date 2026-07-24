import fs from 'fs/promises';
import path from 'path';
import Agent from './Agent.js';
import Action from '../actions/Action.js';
import callProvider from '../utils/providers.js';

export default class Coder extends Agent {
  constructor(apiKey, statusCallback) {
    super('Coder', 'Writes and modifies code based on a plan.');
    this.apiKey = apiKey;
    this.statusCallback = statusCallback || (() => {});
  }

  async run(task, config = {}) {
    this.statusCallback(`Analyzing task: ${task.title}`);
    console.log(`Coder agent is working on: ${task.title}`);

    // Load context: plan + AST
    let blueprint = '';

    try {
      const astData = await fs.readFile('ast.json', 'utf8');
      blueprint += `\n**PROJECT FILE STRUCTURE (AST):**\n${astData}\n`;
    } catch (e) {
      console.error('Error loading ast.json:', e.message);
    }

    try {
      const files = await fs.readdir('.imlil');
      const planFile = files.filter((f) => f.startsWith('plan-') && f.endsWith('.md')).sort().pop();
      if (planFile) {
        const planData = await fs.readFile(path.join('.imlil', planFile), 'utf-8');
        blueprint += `\n**PROJECT PLAN & CONTEXT:**\n${planData}\n`;
      }
    } catch (e) {
      console.error('Error loading project plan:', e.message);
    }

    const maxRetries = 3;

    /**
     * Robust JSON extraction: find the first/best JSON object in the response,
     * handling incomplete or partial output from the model.
     */
    const extractJson = (text) => {
      // Try full JSON parse first
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) {
        const end = trimmed.lastIndexOf('}');
        if (end > 0) {
          const candidate = trimmed.substring(0, end + 1);
          try {
            return JSON.parse(candidate);
          } catch (e) {
            // Not valid JSON, fall through
          }
        }
      }
      // Try regex for any JSON-like object
      const jsonRegex = /\{[\s\S]*?"action"[\s\S]*?"filePath"[\s\S]*?\}/;
      const match = trimmed.match(jsonRegex);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch (e) {
          throw new Error(`JSON parse error in response: ${e.message}`);
        }
      }
      throw new Error('Could not find JSON with action and filePath in response');
    };

    /**
     * Extract code content from markdown code blocks.
     */
    const extractCode = (text) => {
      const codeBlockRegex = /```(?:javascript|js|ts|typescript|jsx|tsx|css|html|json|bash|sh|text)?\n([\s\S]*?)```/i;
      const match = text.match(codeBlockRegex);
      return match ? match[1].trim() : null;
    };

    const callApiWithRetry = async (prompt, apiKey, attempt = 1) => {
      if (attempt > maxRetries) {
        throw new Error(`Failed to get valid response after ${maxRetries} attempts.`);
      }

      try {
        const response = await callProvider(prompt, { apiKey, maxTokens: 4096 });
        if (config.debug) {
          console.error(`-- DEBUG: Raw AI Response (Attempt ${attempt}) --\n${response}\n-- END DEBUG --`);
        }

        // Extract JSON for action metadata
        const action = extractJson(response);

        // Extract code content from markdown code block
        const codeContent = extractCode(response);
        if (codeContent) {
          action.content = codeContent;
        }

        // Validate we have what we need
        if (!action.filePath) {
          throw new Error('Missing filePath in AI response');
        }
        if (!action.action) {
          action.action = 'writeFile'; // default
        }
        if ((action.action === 'writeFile' || action.action === 'writeTest') && !action.content) {
          throw new Error('Missing code content for write action');
        }

        return action;
      } catch (error) {
        console.error(`Attempt ${attempt} failed: ${error.message}. Retrying...`);
        const newPrompt = `${prompt}\n\n**PREVIOUS ATTEMPT FAILED!**\nYour last response was invalid. Error: "${error.message}".\nPlease return EXACTLY this format:\n\n{ "action": "writeFile", "filePath": "src/file.js" }\n\`\`\`javascript\n// your code here\n\`\`\`

Make sure the JSON is valid and the code is in a fenced code block.`;
        return callApiWithRetry(newPrompt, apiKey, attempt + 1);
      }
    };

    // Step 1: Generate code
    const codePrompt = `You are generating code for a task.

**TASK:** "${task.title} - ${task.description}"
${blueprint}

**ACTION:** Create the file with the code content.
**FILE:** Choose the right file path based on the AST.

**OUTPUT FORMAT (EXACT):**
{ "action": "writeFile", "filePath": "path/to/file.js" }
\`\`\`javascript
// The complete file content here
\`\`\``;

    // Step 2: Generate test if applicable
    const testPrompt = `You are generating a unit test for a task.

**TASK:** "${task.title} - ${task.description}"
${blueprint}

**INSTRUCTIONS:**
1. Write a unit test for the code created in this task.
2. Tests go in a "__tests__" folder at the same level as the source.

**OUTPUT FORMAT (EXACT):**
{ "action": "writeTest", "filePath": "src/__tests__/file.test.js" }
\`\`\`javascript
// test content here
\`\`\``;

    try {
      this.statusCallback(`Generating code for: ${task.title}`);
      const codeAction = await callApiWithRetry(codePrompt, this.apiKey);

      this.statusCallback(`Generating tests for: ${task.title}`);
      const testAction = await callApiWithRetry(testPrompt, this.apiKey);

      const codePath = codeAction.filePath;
      const testPath = testAction.filePath;

      if (!codePath || !testPath) {
        throw new Error(`Missing file path in AI response. Code: ${codePath}, Test: ${testPath}`);
      }

      await this.executeAction(codeAction);
      await this.executeAction(testAction);

      return { codePath, testPath };
    } catch (error) {
      console.error(`Error in Coder.run for task "${task.title}": ${error.message}`);
      throw error;
    }
  }

  async executeAction(action) {
    this.statusCallback(`Executing: ${action.action} on ${action.filePath}`);
    console.log(`Executing action: ${action.action}`);
    switch (action.action) {
      case 'writeFile':
        return Action.writeFile(action.filePath, action.content);
      case 'writeTest':
        return Action.writeTest(action.filePath, action.content);
      case 'modifyFile':
        return Action.modifyFile(action.filePath, action.content);
      case 'smartEdit':
        return Action.smartEdit(action.filePath, action.content);
      default:
        console.error(`Unknown action: ${action.action}`);
        return { status: 'failed', error: `Unknown action: ${action.action}` };
    }
  }
}