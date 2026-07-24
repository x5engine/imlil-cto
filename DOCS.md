# `imlil` Documentation

This document provides a deeper dive into the architecture and functionality of `imlil`.

## Architecture

`imlil` uses a multi-agent system to build projects. The main agents are:

-   **Supervisor Agent**: This is the project manager. It takes the user's initial prompt, creates a plan, and delegates tasks to Operator agents.
-   **Operator Agent**: This agent is responsible for executing a specific task from the plan. It uses the AI model to generate the code or commands needed to complete the task.
-   **Coder Agent**: This agent is specialized in writing and modifying code. It receives instructions from the Operator and performs file system operations.

### The Flow

1.  The user runs `imlil make "..."`.
2.  The `SupervisorAgent` is instantiated.
3.  The `SupervisorAgent` creates a high-level plan using the AI model.
4.  The plan is broken down into a series of tasks.
5.  The `SupervisorAgent` assigns tasks to `Operator` agents, up to `maxAgents`.
6.  Each `Operator` agent uses the AI model to generate a sequence of actions (like `writeFile`, `gitCommit`, etc.) to complete its task.
7.  The actions are executed by the `Coder` agent.
8.  The process continues until all tasks are completed.

## Configuration (`imlil.config.js`)

-   **`mode`**: Can be `'yolo'` or `'safe'`. In `yolo` mode, the agents are given more freedom to experiment. `'safe'` mode will be more conservative. (Note: `'safe'` mode is not yet fully implemented).
-   **`maxAgents`**: An integer that determines how many agents can run in parallel. This is useful for controlling API usage and resource consumption.
-   **`cliPersonality`**: A system prompt that is prepended to every call to the AI model. This allows you to customize the personality and tone of the CLI's output and behavior.

## Agents in Detail

### `SupervisorAgent.js`

-   **Purpose**: To manage the overall project creation process.
-   **Key Methods**:
    -   `run()`: The main entry point. It creates a plan and starts assigning tasks.
    -   `createPlan()`: Interacts with the AI to get a structured plan.
    -   `assignTask()`: Creates and dispatches an `Operator` agent for a task.

### `Operator.js`

-   **Purpose**: To execute a single task from the plan.
-   **Key Methods**:
    -   `run()`: Takes a task and generates a series of actions to complete it.
    -   `executeAction()`: Executes a single action, like writing a file or running a command.

### `coder.js`

-   **Purpose**: A specialized agent for code generation and modification.
-   **Key Methods**:
    -   `run()`: Takes a task and generates code.
    -   `executeAction()`: Interacts with the `Action.js` toolkit to modify the filesystem.

## The Action Toolkit (`Action.js`)

This class provides a set of methods that agents can use to interact with the user's system. It's a layer of abstraction over the filesystem and git.

-   `writeFile(filePath, content)`
-   `readFile(filePath)`
-   `gitAdd(files)`
-   `gitCommit(message)`

This architecture allows for extending the tool's capabilities by adding new actions and new types of agents.
