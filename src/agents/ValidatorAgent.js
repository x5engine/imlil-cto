import { exec } from 'child_process';
import util from 'util';
import Agent from './Agent.js';

const execAsync = util.promisify(exec);

class ValidatorAgent extends Agent {
  constructor(name, purpose, aiModel, apiKey, config) {
    super(name, purpose);
    this.aiModel = aiModel;
    this.apiKey = apiKey;
    this.config = config;
  }

  /**
   * Validate a completed task.
   * Skips heavy syntax checking — just verifies the file exists and has content.
   * Heavy validation happens in the QA phase (npm test, npm build).
   */
  static async validate(task, testPath) {
    // Fast path: file exists check only
    if (!testPath) {
      return { isValid: true, output: 'No test path — skipping validation' };
    }

    try {
      // Check test file exists
      const fs = await import('fs/promises');
      await fs.access(testPath);

      // Check it has content
      const content = await fs.readFile(testPath, 'utf8');
      if (content.trim().length === 0) {
        return { isValid: false, error: 'Test file is empty' };
      }

      return { isValid: true, output: 'File exists and has content' };
    } catch (error) {
      return { isValid: false, error: error.message };
    }
  }
}

export default ValidatorAgent;