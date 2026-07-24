#!/usr/bin/env node

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { program } from 'commander';
import { findUp } from 'find-up';
import { initializeDatabase, getDb } from '../src/utils/db.js';
import SupervisorAgent from '../src/agents/SupervisorAgent.js';
import ScrumAgent from '../src/agents/ScrumAgent.js';
import ValidatorAgent from '../src/agents/ValidatorAgent.js';
import { callEmbedApi } from '../src/utils/embedapi.js';
import os from 'os';
import inquirer from 'inquirer';
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import Piscina from 'piscina';

// --- API Key Management ---

async function getApiKey() {
    if (process.env.IMLIL_API_KEY) {
        return process.env.IMLIL_API_KEY;
    }

    const configPath = path.join(os.homedir(), '.imlil');
    try {
        const apiKey = await fs.readFile(configPath, 'utf8');
        return apiKey.trim();
    } catch (error) {
        const { apiKey } = await inquirer.prompt([
            {
                type: 'password',
                name: 'apiKey',
                message: 'Please enter your EmbedAPI key:',
            },
        ]);
        await fs.writeFile(configPath, apiKey);
        return apiKey;
    }
}

// --- Main Application ---

program
    .command('make <project_description>')
    .description('Create a new project by orchestrating agents')
    .option('--debug', 'Enable debug mode to see raw AI responses.')
    .option('--max-agents <num>', 'Set the maximum number of parallel agents.')
    .action(async (project_description, options) => {
        const isTTY = process.stdout.isTTY;
        let screen, grid, logBox, agentStatusBox, statsBox, progressBar;

        if (isTTY) {
            screen = blessed.screen({
                smartCSR: true,
                title: 'imlil - NASA Control Room'
            });

            grid = new contrib.grid({rows: 12, cols: 12, screen: screen});

            logBox = grid.set(0, 0, 10, 8, blessed.log, {
                label: 'Mission Log',
                tags: true,
                border: { type: 'line' },
                style: { border: { fg: 'cyan' } }
            });

            agentStatusBox = grid.set(0, 8, 7, 4, blessed.box, {
                label: 'Agent Status',
                tags: true,
                border: { type: 'line' },
                style: { border: { fg: 'green' } }
            });

            statsBox = grid.set(7, 8, 3, 4, blessed.box, {
                label: 'Mission Stats',
                tags: true,
                border: { type: 'line' },
                style: { border: { fg: 'magenta' } }
            });
            
            progressBar = grid.set(10, 0, 2, 12, blessed.progressbar, {
                label: 'Overall Progress',
                border: { type: 'line' },
                style: { border: { fg: 'yellow' }, bar: { bg: 'yellow' } },
                filled: 0
            });

            screen.render();
        } else {
            // No UI components for non-TTY mode
            logBox = null;
            agentStatusBox = null;
            statsBox = null;
            progressBar = null;
            screen = null;
        }

        const logStream = await fs.open('imlil.log', 'w');
        
        console.log = (...args) => {
            const message = args.join(' ');
            if (logBox) logBox.log(message);
            else process.stdout.write(message + '\n');
            logStream.write(`${new Date().toISOString()} - ${message}\n`);
            if (screen) screen.render();
        };

        console.error = (...args) => {
            const message = args.join(' ');
            if (logBox) logBox.log(`{red-fg}ERROR: ${message}{/red-fg}`);
            else process.stderr.write(`ERROR: ${message}\n`);
            logStream.write(`${new Date().toISOString()} - ERROR: ${message}\n`);
        };

        setTimeout(() => {
            if (logBox) logBox.log('{red-fg}MISSION ABORTED: Time limit exceeded (10m).{/red-fg}');
            else console.log('MISSION ABORTED: Time limit exceeded (10m).');
            logStream.write(`${new Date().toISOString()} - MISSION ABORTED: Time limit exceeded.\n`);
            if (screen) screen.render();
            setTimeout(() => {
                if (screen) screen.destroy();
                process.exit(1);
            }, 3000);
        }, 600000); 

        const apiKey = await getApiKey();
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const packageJsonPath = await findUp('package.json', { cwd: __dirname });
        const projectRoot = path.dirname(packageJsonPath);

        let config = {
            mode: 'yolo',
            maxAgents: 20,
            cliPersonality: `You are a sick bro, a funny, over-motivated guru developer.`,
            debug: !!options.debug
        };

        try {
            const configPath = path.resolve(projectRoot, 'imlil.config.js');
            const configModule = await import(configPath);
            Object.assign(config, configModule.default);
        } catch (error) {}

        if (options.maxAgents) {
            config.maxAgents = parseInt(options.maxAgents, 10);
        }

        const aiModel = {
            generateText: async (params) => {
                const { messages } = params;
                const lastMessage = messages[messages.length - 1];
                const fullPrompt = `${config.cliPersonality}\n\n${lastMessage.content}`;
                const response = await callEmbedApi(fullPrompt, apiKey);
                return { completion: [{ text: response }] };
            }
        };

        await initializeDatabase();
        const supervisor = new SupervisorAgent('Supervisor', 'Orchestrates the project', aiModel, apiKey, config);
        await supervisor.run(project_description);
        await orchestrator(config, apiKey, projectRoot, screen, logBox, agentStatusBox, statsBox, progressBar);
    });

async function orchestrator(config, apiKey, projectRoot, screen, logBox, agentStatusBox, statsBox, progressBar) {
    const db = getDb();
    const scrumMaster = new ScrumAgent('Scrum Master', 'Manages the task backlog', null, apiKey, config);
    const validator = new ValidatorAgent('Validator', 'Validates completed tasks', null, apiKey, config);
    
    logBox.log('{bold}Orchestrator: Agent army, ATTENTION! MISSION START!{/bold}');

    const piscina = new Piscina({
        filename: path.resolve(projectRoot, 'src/agents/worker.js'),
        minThreads: 1,
        maxThreads: config.maxAgents
    });

    const activeTasks = new Map();
    const validationQueue = [];

    const updateAgentStatus = async () => {
        let content = '{bold}ACTIVE OPERATORS:{/bold}\n';
        let i = 1;
        activeTasks.forEach((task) => {
            const status = task.currentActivity || 'Initializing...';
            // Truncate status if too long
            const displayStatus = status.length > 40 ? status.substring(0, 37) + '...' : status;
            content += `{yellow-fg}Operator ${i++}: ${displayStatus} | ${task.title}{/yellow-fg}\n`;
        });
        if (validationQueue.length > 0) {
            content += '\n{bold}VALIDATION QUEUE:{/bold}\n';
            validationQueue.forEach((item) => {
                content += `{magenta-fg}Validator 1: CHECKING - ${item.task.title}{/magenta-fg}\n`;
            });
        }
        agentStatusBox.setContent(content);

        // Update Stats Box
        const pendingCount = (await db.all('SELECT count(*) as count FROM tasks WHERE status = ?', 'pending'))[0].count;
        const completedCount = (await db.all('SELECT count(*) as count FROM tasks WHERE status = ?', 'completed'))[0].count;
        const totalCount = (await db.all('SELECT count(*) as count FROM tasks'))[0].count;

        let statsContent = '';
        statsContent += `{blue-fg}Operators Active: {/blue-fg}${activeTasks.size}/${config.maxAgents}\n`;
        statsContent += `{blue-fg}Validators Active: {/blue-fg}${validationQueue.length > 0 ? 1 : 0}\n`;
        statsContent += `{blue-fg}Tasks: {/blue-fg}${completedCount}/${totalCount} (${pendingCount} pending)\n`;
        statsContent += `{blue-fg}Total Agents: {/blue-fg}${activeTasks.size + (validationQueue.length > 0 ? 1 : 0) + 1}\n`;
        statsBox.setContent(statsContent);

        screen.render();
    };

    const processTasks = async () => {
        const totalTasks = (await db.all('SELECT * FROM tasks')).length;
        let isProcessing = false;
        let qaDone = false;

        const scheduler = async () => {
            if (isProcessing) return;
            isProcessing = true;

            try {
                // Refresh counts
                let currentTotalTasks = (await db.all('SELECT count(*) as count FROM tasks'))[0].count;
                let completedTasksCount = (await db.all('SELECT count(*) as count FROM tasks WHERE status = ?', 'completed'))[0].count;
                let failedTasksCount = (await db.all('SELECT count(*) as count FROM tasks WHERE status = ?', 'failed'))[0].count;
                
                progressBar.filled = (completedTasksCount / currentTotalTasks) * 100;
                await updateAgentStatus();

                if (completedTasksCount + failedTasksCount >= currentTotalTasks) {
                    if (!qaDone) {
                        qaDone = true;
                        logBox.log('\n{magenta-fg}{bold}Phase 4: QA & Self-Healing...{/bold}{/magenta-fg}');
                        screen.render();

                        try {
                            const { exec } = await import('child_process');
                            const util = await import('util');
                            const execPromise = util.promisify(exec);

                            logBox.log('Running tests (npm test)...');
                            screen.render();
                            // Run tests with CI=true to avoid watch mode
                            await execPromise('npm test -- --watchAll=false', { 
                                cwd: process.cwd(),
                                env: { ...process.env, CI: 'true' }
                            });
                            logBox.log('{green-fg}Tests Passed!{/green-fg}');

                            logBox.log('Running build (npm run build)...');
                            screen.render();
                            await execPromise('npm run build', { cwd: process.cwd() });
                            logBox.log('{green-fg}Build Successful!{/green-fg}');
                            
                        } catch (error) {
                            const errorOutput = (error.stdout || '') + '\n' + (error.stderr || '') + '\n' + error.message;
                            logBox.log(`{red-fg}QA Failed! Generating fix task...{/red-fg}`);
                            
                            // Truncate error if too massive, but keep tail
                            const lastErrors = errorOutput.slice(-2000); 
                            
                            await scrumMaster.addTask(
                                'Fix QA Failure', 
                                `The application failed validation.\nError Log:\n${lastErrors}\n\nAnalyze the error and fix the code.`,
                                []
                            );
                            
                            qaDone = false; // Reset to allow re-testing after fix
                            screen.render();
                            return; // Continue scheduler loop to pick up new task
                        }
                    }

                    progressBar.filled = 100;
                    logBox.log('\n{blue-fg}{bold}MISSION COMPLETE! ALL TASKS PROCESSED & VERIFIED!{/bold}{/blue-fg}');
                    screen.render();
                    setTimeout(() => {
                        screen.destroy();
                        process.exit(0);
                    }, 3000);
                    return;
                }

                while (activeTasks.size < config.maxAgents) {
                    const nextTask = await scrumMaster.getNextTask();
                    if (!nextTask) break;

                    logBox.log(`{blue-fg}ScrumMaster: Dispatching task "${nextTask.title}" to Operator...{/blue-fg}`);
                    nextTask.currentActivity = 'Receiving instructions...'; // Init status
                    activeTasks.set(nextTask.id, nextTask);
                    await updateAgentStatus();

                    piscina.run({ task: nextTask, apiKey, config }).then(async (result) => {
                        activeTasks.delete(nextTask.id);
                        validationQueue.push(result);
                        await updateAgentStatus();
                        handleValidation(); 
                    }).catch(err => {
                        console.error(`CRITICAL ERROR in Worker for task "${nextTask.title}": ${err.message}`);
                        activeTasks.delete(nextTask.id);
                        updateAgentStatus();
                    });
                }
            } finally {
                isProcessing = false;
            }
        };

        // Run scheduler immediately and set a heartbeat
        await scheduler();
        setInterval(scheduler, 200); 
    };

    const handleValidation = async () => {
        if (validationQueue.length === 0) return;

        const item = validationQueue.shift();
        
        if (item.status !== 'completed') {
            logBox.log(`{red-fg}Worker failed task "${item.task.title}": ${item.error || 'Unknown error'}. Re-queuing...{/red-fg}`);
            await scrumMaster.requeueTask(item.task);
            await updateAgentStatus();
            return;
        }

        logBox.log(`{magenta-fg}Validator 1: Scrutinizing result for "${item.task.title}"...{/magenta-fg}`);
        await updateAgentStatus();
        
        const { isValid, error } = await validator.validate(item.task, item.testPath);

        if (isValid) {
            await scrumMaster.markTaskAsCompleted(item.task);
            logBox.log(`{green-fg}Validator 1: Task "${item.task.title}" passes!{/green-fg}`);
        } else {
            await scrumMaster.requeueTask(item.task);
            logBox.log(`{red-fg}Validator 1: REJECTED! Task "${item.task.title}" failed: ${error}. Retrying...{/red-fg}`);
        }
        await updateAgentStatus();
    };

    piscina.on('message', (msg) => {
        if (msg && msg.type === 'log') {
            if (msg.level === 'error') {
                console.error(`[Worker] ${msg.message}`); 
            } else {
                console.log(`[Worker] ${msg.message}`);
            }
        } else if (msg && msg.type === 'activity') {
            const task = activeTasks.get(msg.taskId);
            if (task) {
                task.currentActivity = msg.action;
                // We could call updateAgentStatus here, but it might be too frequent.
                // The scheduler calls it every 200ms anyway.
                // But for "live" feel, let's call it.
                // Optimization: Debounce or throttle this if it flickers too much.
                // For now, raw update.
                updateAgentStatus();
            }
        }
    });

    await processTasks();
    screen.key(['escape', 'q', 'C-c'], () => process.exit(0));
}

program.parse(process.argv);
