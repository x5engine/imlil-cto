import { parentPort } from 'worker_threads';
import Coder from './coder.js';
import { initializeDatabase } from '../utils/db.js';

let dbInitialized = false;

// Redirect console logs to parent thread (for general logging)

console.log = (...args) => {
  const message = args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg))).join(' ');
  parentPort.postMessage({ type: 'log', level: 'info', message });
};

console.error = (...args) => {
  const message = args.map((arg) => {
    if (arg instanceof Error) {
      return `${arg.message}\n${arg.stack}`;
    }
    return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg);
  }).join(' ');
  parentPort.postMessage({ type: 'log', level: 'error', message });
};

export default async ({ task, apiKey, config }) => {
  if (!dbInitialized) {
    await initializeDatabase();
    dbInitialized = true;
  }

  const statusCallback = (activity) => {
    parentPort.postMessage({
      type: 'activity',
      taskId: task.id,
      action: activity,
    });
  };

  // Create a new Coder instance for each task to bind the specific callback
  const coder = new Coder(apiKey, statusCallback);

  try {
    const { codePath, testPath } = await coder.run(task, config);
    return {
      status: 'completed', task, codePath, testPath,
    };
  } catch (error) {
    if (error.message.includes('timed out')) {
      return { status: 'timed_out', task, error: error.message };
    }
    return { status: 'failed', task, error: error.message };
  }
};
