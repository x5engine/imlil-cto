class Agent {
  constructor(name, purpose) {
    this.id = Agent.generateId();
    this.name = name;
    this.purpose = purpose;
    this.state = 'idle'; // idle, init, working, stopped
    this.progress = 0;
    this.result = null;
    this.error = null;
    this.intervalId = null;
  }

  static generateId() {
    return Math.random().toString(36).substr(2, 9);
  }

  // Initialize the agent
  init() {
    if (this.state !== 'idle') {
      throw new Error('Agent must be idle to initialize');
    }
    this.state = 'init';
    this.progress = 0;
    this.result = null;
    this.error = null;
  }

  // Start the agent's work
  start(interval = 1000) {
    if (this.state !== 'init') {
      throw new Error('Agent must be initialized to start');
    }
    this.state = 'working';
    this.intervalId = setInterval(() => this.execute(), interval);
  }

  // Stop the agent
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.state = 'stopped';
  }

  // Execute the agent's purpose (to be implemented by specific agents)
  // eslint-disable-next-line class-methods-use-this
  execute() {
    throw new Error('Abstract method execute() must be implemented by subclass');
  }

  // Get the current state of the agent
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      progress: this.progress,
      result: this.result,
      error: this.error,
    };
  }
}

export default Agent;
