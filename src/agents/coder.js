import fs from 'fs/promises';
import path from 'path';
import Agent from './Agent.js';
import Action from '../actions/Action.js';
import { callWithTools } from '../utils/providers.js';

/**
 * Coder agent using function calling.
 *
 * Instead of parsing regex from free-form model output, we define tools
 * (writeFile, writeTest) that the model calls natively. The model returns
 * structured tool_calls with guaranteed-valid JSON arguments.
 *
 * Zero regex. Zero JSON parse errors.
 */

const CODE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'writeFile',
      description: 'Create a NEW file with the given content. Use for ALL new files including source code, configs, etc.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the file relative to project root (e.g. src/index.js)' },
          content: { type: 'string', description: 'The complete file content' },
        },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'writeTest',
      description: 'Write a unit test file. Tests go in a __tests__ folder parallel to the source.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the test file (e.g. src/__tests__/file.test.js)' },
          content: { type: 'string', description: 'The complete test file content using Jest' },
        },
        required: ['filePath', 'content'],
      },
    },
  },
];

export default class Coder extends Agent {
  constructor(apiKey, statusCallback) {
    super('Coder', 'Writes and modifies code based on a plan.');
    this.apiKey = apiKey;
    this.statusCallback = statusCallback || (() => {});
  }

  async run(task, config = {}) {
    this.statusCallback(`Analyzing task: ${task.title}`);
    console.log(`Coder agent working on: ${task.title}`);

    // Load context: project AST + plan
    let context = `Task: ${task.title} — ${task.description}\n\n`;

    try {
      const astData = await fs.readFile('ast.json', 'utf8');
      context += `Project file structure (AST):\n${astData}\n`;
    } catch (e) { /* no ast */ }

    try {
      const files = await fs.readdir('.imlil');
      const planFile = files.filter(f => f.startsWith('plan-') && f.endsWith('.md')).sort().pop();
      if (planFile) {
        const plan = await fs.readFile(path.join('.imlil', planFile), 'utf-8');
        context += `Plan:\n${plan.slice(0, 3000)}\n`; // Keep context manageable
      }
    } catch (e) { /* no plan file */ }

    const maxRetries = 2;

    const callWithRetry = async (messages, attempt = 1) => {
      if (attempt > maxRetries) {
        throw new Error(`Failed after ${maxRetries} retries`);
      }

      const result = await callWithTools(messages, CODE_TOOLS, { apiKey: this.apiKey, maxTokens: 4096 });

      if (config.debug) {
        console.error(`-- DEBUG Tool calls: ${JSON.stringify(result.toolCalls)}`);
      }

      // Extract the tool calls
      for (const tc of result.toolCalls) {
        if (tc.type === 'function') {
          const fn = tc.function;
          const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
          return {
            action: fn.name,
            filePath: args.filePath,
            content: args.content,
          };
        }
      }

      // If no tool call but there's text content, try parsing it
      if (result.content) {
        try {
          const parsed = JSON.parse(result.content);
          if (parsed.filePath) {
            return {
              action: parsed.action || 'writeFile',
              filePath: parsed.filePath,
              content: parsed.content,
            };
          }
        } catch { /* not JSON */ }
      }

      // Retry with stronger instructions
      const retryMsg = `You MUST use one of the available tools (writeFile or writeTest) to complete this task.\n\nDo NOT just reply with text. Call the appropriate function with the file path and code content.`;
      messages.push({ role: 'assistant', content: result.content || '' });
      messages.push({ role: 'user', content: retryMsg });
      return callWithRetry(messages, attempt + 1);
    };

    // --- Generate code ---
    this.statusCallback(`Generating code for: ${task.title}`);
    const codeResult = await callWithRetry([
      { role: 'system', content: `You are a senior software engineer generating production code. Always use the available tools to write files. Never respond with plain text.` },
      { role: 'user', content: `Write the code for this task:\n\n${context}\n\nUse writeFile to create the source file.` },
    ]);

    // --- Generate tests ---
    this.statusCallback(`Generating tests for: ${task.title}`);
    const testResult = await callWithRetry([
      { role: 'system', content: `You are writing unit tests using Jest. Always use the writeTest tool.` },
      { role: 'user', content: `Write unit tests for the code created in this task:\n\n${context}\n\nThe source file was written to: ${codeResult.filePath}\n\nUse writeTest to create the test file in a __tests__ folder.` },
    ]);

    const codePath = codeResult.filePath;
    const testPath = testResult.filePath;

    if (!codePath) {
      throw new Error('No file path returned from code generation');
    }

    await this.executeAction({
      action: codeResult.action || 'writeFile',
      filePath: codePath,
      content: codeResult.content,
    });

    if (testPath && testResult.content) {
      await this.executeAction({
        action: testResult.action || 'writeTest',
        filePath: testPath,
        content: testResult.content,
      });
    }

    return { codePath, testPath: testPath || '' };
  }

  async executeAction(action) {
    this.statusCallback(`Writing: ${action.filePath}`);
    console.log(`Executing: ${action.action} -> ${action.filePath}`);
    switch (action.action) {
      case 'writeFile':
        return Action.writeFile(action.filePath, action.content);
      case 'writeTest':
        return Action.writeTest(action.filePath, action.content);
      default:
        return Action.writeFile(action.filePath, action.content);
    }
  }
}