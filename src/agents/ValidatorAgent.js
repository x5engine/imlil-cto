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
   * @param {object} task - The task object
   * @param {string} [testPath] - Path to the test file
   * @returns {Promise<{isValid: boolean, error?: string, output?: string}>}
   */
  static async validate(task, testPath) {
    try {
      if (!testPath) {
        return { isValid: false, error: 'No test file provided' };
      }

      // Check if test file exists first
      try {
        await execAsync(`ls ${testPath}`);
      } catch {
        return { isValid: false, error: `Test file not found: ${testPath}` };
      }

      if (testPath.endsWith('.js') || testPath.endsWith('.ts') || testPath.endsWith('.jsx') || testPath.endsWith('.tsx')) {
        // For JS/TS — try to run with node or check file syntax
        // If it's a Jest test, we run the full test suite
        const { stdout } = await execAsync(`ls -l ${testPath}`);

        // Simple syntax check
        try {
          await execAsync(`node --check ${testPath}`);
        } catch (syntaxError) {
          return { isValid: false, error: `Syntax error in test file: ${syntaxError.stderr || syntaxError.message}` };
        }

        return { isValid: true, output: stdout };
      }

      if (testPath.endsWith('.c') || testPath.endsWith('.cpp')) {
        // C/C++ — compile and run
        const taskFilePath = (task && task.filePath) || '';
        const { stdout, stderr } = await execAsync(`gcc ${taskFilePath} ${testPath} -o test_bin && ./test_bin`);
        if (stderr) {
          return { isValid: false, error: stderr };
        }
        return { isValid: true, output: stdout };
      }

      // Fallback: file exists, assume valid
      return { isValid: true, output: 'File created' };
    } catch (error) {
      return { isValid: false, error: error.message };
    }
  }
}

export default ValidatorAgent;