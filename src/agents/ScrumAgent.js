import Agent from './Agent.js';
import { getDb } from '../utils/db.js';

class ScrumAgent extends Agent {
  constructor(name, purpose, aiModel, apiKey, config) {
    super(name, purpose);
    this.aiModel = aiModel;
    this.apiKey = apiKey;
    this.config = config;
    this.db = getDb();
  }

  static async run() {
    // The ScrumAgent's run loop will be managed by the orchestrator
  }

  async getNextTask() {
    const pendingTasks = await this.db.all('SELECT * FROM tasks WHERE status = ?', 'pending');
    const completedTasks = (await this.db.all('SELECT id FROM tasks WHERE status = ?', 'completed')).map((t) => t.id);

    console.log(`DEBUG: Pending: ${pendingTasks.length}, Completed IDs: ${completedTasks.join(',')}`);
    console.log(`DEBUG: Current Config: ${JSON.stringify(this.config)}`);

    for (const task of pendingTasks) {
      let dependencies = [];
      try {
        dependencies = JSON.parse(task.dependencies);
      } catch (e) {
        console.error(`Error parsing dependencies for task ${task.id}:`, task.dependencies);
        continue;
      }

      const areDepsMet = this.config.mode === 'yolo' ? true : dependencies.every((dep) => completedTasks.includes(String(dep)));

      console.log(`DEBUG: Task ${task.id} ("${task.title}") deps: [${dependencies.join(',')}]. Met? ${areDepsMet} (Mode: ${this.config.mode})`);

      if (areDepsMet) {
        // LOCK IT DOWN: Mark as running immediately to prevent other agents from grabbing it
        await this.db.run('UPDATE tasks SET status = ? WHERE id = ?', 'running', task.id);
        return task;
      }
    }

    return null;
  }

  async assignTaskToAgent(task) {
    await this.db.run('UPDATE tasks SET status = ? WHERE id = ?', 'assigned', task.id);
  }

  async markTaskAsCompleted(task) {
    await this.db.run('UPDATE tasks SET status = ? WHERE id = ?', 'completed', task.id);
  }

  async requeueTask(task) {
    await this.db.run('UPDATE tasks SET status = ?, retries = retries + 1 WHERE id = ?', 'pending', task.id);
  }

  async addTask(title, description, dependencies = []) {
    const id = Date.now().toString() + Math.floor(Math.random() * 1000).toString();
    await this.db.run(
      'INSERT INTO tasks (id, title, description, status, dependencies, retries) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      title,
      description,
      'pending',
      JSON.stringify(dependencies),
      0,
    );
    return id;
  }
}

export default ScrumAgent;
