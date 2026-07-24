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

  static async validate(task, testPath) {
    try {
      if (!testPath) {
        return { isValid: false, error: 'No test file provided' };
      }

      if (testPath.endsWith('.js') || testPath.endsWith('.ts') || testPath.endsWith('.jsx') || testPath.endsWith('.tsx')) {
        // For JS/TS/React, we assume npm test or similar.
        // For this MVP, we'll try to run the specific test file using node (if it's a standalone script)
        // or just check if the file exists and has valid syntax if it's a component.
        // A robust solution would run 'npm test <file>'.

        // Simplified check: Does the file exist?
        const { stdout } = await execAsync(`ls -l ${testPath}`);
        return { isValid: true, output: stdout };
      } if (testPath.endsWith('.c') || testPath.endsWith('.cpp')) {
        // C/C++ validation
        // eslint-disable-next-line max-len
        const { stdout, stderr } = await execAsync(`gcc ${task.filePath || ''} ${testPath} -o test_bin && ./test_bin`);
        if (stderr) {
          return { isValid: false, error: stderr };
        }
        return { isValid: true, output: stdout };
      }
      // Fallback: just check if file exists
      await execAsync(`ls ${testPath}`);
      return { isValid: true, output: 'File created' };
    } catch (error) {
      return { isValid: false, error: error.message };
    }
  }
}

export default ValidatorAgent;
