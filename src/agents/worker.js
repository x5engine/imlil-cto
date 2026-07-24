import { parentPort } from 'worker_threads';
import Coder from './coder.js';
import { connectToDatabase } from '../utils/db.js';

let dbInitialized = false;

// Redirect console logs to parent thread
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

export default async ({ task, apiKey, config, dbPath }) => {
  if (!dbInitialized) {
    if (dbPath) {
      await connectToDatabase(dbPath);
    }
    dbInitialized = true;
  }

  const statusCallback = (activity) => {
    parentPort.postMessage({
      type: 'activity',
      taskId: task.id,
      action: activity,
    });
  };

  const coder = new Coder(apiKey, statusCallback);

  // Run with 90s timeout per task — if it hangs, mark as failed
  const result = await Promise.race([
    coder.run(task, config).then(({ codePath, testPath }) => ({
      status: 'completed', task, codePath, testPath,
    })),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Task timed out after 90s')), 90000)
    ),
  ]);

  return result;
};