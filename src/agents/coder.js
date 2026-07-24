import fs from 'fs/promises';
import path from 'path';
import Agent from './Agent.js';
import Action from '../actions/Action.js';
import callEmbedApi from '../utils/embedapi.js';

export default class Coder extends Agent {
  constructor(apiKey, statusCallback) {
    super('Coder', 'Writes and modifies code based on a plan.');
    this.apiKey = apiKey;
    this.statusCallback = statusCallback || (() => {});
  }

  async run(task, config = {}) {
    this.statusCallback(`Analyzing task: ${task.title}`);
    console.log(`Coder agent is working on: ${task.title}`);

    let blueprint = '';

    // 1. Load AST (File Structure)
    try {
      const astData = await fs.readFile('ast.json', 'utf8');
      blueprint += `\n**PROJECT FILE STRUCTURE (AST):**\n${astData}\n`;
    } catch (e) {
      console.error('Error loading ast.json:', e.message);
    }

    // 2. Load Detailed Plan
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

    // 3. Legacy Fallback
    try {
      const blueprintData = await fs.readFile('imlil.blueprint.json', 'utf8');
      blueprint += `\n**PROJECT BLUEPRINT (LEGACY):**\n${blueprintData}\n`;
    } catch (e) {
      console.error('Error loading legacy blueprint:', e.message);
    }

    const maxRetries = 3;

    const callApiWithRetry = async (prompt, apiKey, attempt = 1) => {
      if (attempt > maxRetries) {
        throw new Error(`Failed to get valid response after ${maxRetries} attempts.`);
      }

      try {
        const response = await callEmbedApi(prompt, apiKey);
        if (config.debug) {
          console.error(`-- DEBUG: Raw AI Response (Attempt ${attempt}) --\n${response}\n-- END DEBUG --`);
        }

        // 1. Extract JSON for metadata
        const jsonRegex = /\{[\s\S]*?\}/;
        // eslint-disable-next-line prefer-destructuring
        const jsonMatch = response.match(jsonRegex);

        if (!jsonMatch || !jsonMatch[0]) {
          throw new Error('Could not find JSON object in response');
        }

        let action;
        try {
          action = JSON.parse(jsonMatch[0]);
        } catch (e) {
          throw new Error(`JSON parse error: ${e.message}`);
        }

        // 2. Extract Code Content (Robust Strategy)
        // If content is not in JSON (or is empty), look for Markdown block
        if (!action.content || action.content.trim() === '') {
          const codeBlockRegex = /```(?:javascript|js|ts|typescript|jsx|tsx|css|html|json|bash|sh|text)?\n([\s\S]*?)```/i;
          const codeMatch = response.match(codeBlockRegex);

          if (codeMatch && codeMatch[1]) {
            action.content = codeMatch[1];
          } else if (action.action.startsWith('write') || action.action === 'modifyFile' || action.action === 'smartEdit') {
            throw new Error('Missing file content. Content must be in a Markdown code block or in the JSON "content" field.');
          }
        }

        return action;
      } catch (error) {
        console.error(`Attempt ${attempt} failed: ${error.message}. Retrying...`);
        const newPrompt = `${prompt}\n\n**PREVIOUS ATTEMPT FAILED!**\nYour last response was invalid. Error: "${error.message}". \nPlease return a valid JSON object for the action/path, AND put the code content in a standard Markdown code block outside the JSON.`;
        return callApiWithRetry(newPrompt, apiKey, attempt + 1);
      }
    };

    const codePrompt = `
            You are a specialized AI agent responsible for generating code.
            
            **TASK:** "${task.title} - ${task.description}"
            ${blueprint}

            **AVAILABLE ACTIONS:**
            1. "writeFile": Create a NEW file.
            2. "modifyFile": Modify an EXISTING file surgically using jscodeshift (AST-based).
            3. "smartEdit": Specialized for complex refactoring/imports (uses tree-sitter + jscodeshift).

            **STRATEGY:**
            - For NEW files, use "writeFile".
            - For EXISTING files, use "modifyFile" or "smartEdit". This is the PREFERRED way to edit.
            
            **modifyFile INSTRUCTIONS:**
            Your output must be the BODY of a jscodeshift transform function: \`(file, api) => string\`.
            The API provides \`api.j\` (jscodeshift instance).
            
            **Example (Adding an import):**
            { "action": "modifyFile", "filePath": "src/App.js" }
            \`\`\`javascript
            const j = api.j;
            const root = j(file.source);
            const newImport = j.importDeclaration(
                [j.importSpecifier(j.identifier('MyComp'))],
                j.literal('./MyComp')
            );
            root.find(j.ImportDeclaration).at(0).insertBefore(newImport);
            return root.toSource();
            \`\`\`

            **Example (Updating a value):**
            { "action": "modifyFile", "filePath": "src/config.js" }
            \`\`\`javascript
            const j = api.j;
            return j(file.source)
                .find(j.Identifier, { name: 'VERSION' })
                .replaceWith(j.literal('2.0.0'))
                .toSource();
            \`\`\`

            **OUTPUT FORMAT:**
            { "action": "modifyFile", "filePath": "path/to/file.js" }
            \`\`\`javascript
            // jscodeshift code here
            \`\`\`
        `;

    const testPrompt = `
            You are a specialized AI agent responsible for generating unit tests.
            
            **TASK:** "${task.title} - ${task.description}"
            ${blueprint}

            **INSTRUCTIONS:**
            1.  Write the unit test for this task.
            2.  Output a JSON object with the 'action' ("writeTest") and 'filePath'.
            3.  Output the *test code* in a Markdown code block.
            
            **RULE:** Tests must be in a "__tests__" folder at the same level as the source file.

            **REQUIRED OUTPUT FORMAT:**
            { "action": "writeTest", "filePath": "src/__tests__/file.test.js" }
            \`\`\`javascript
            // Test content
            \`\`\`
        `;

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
