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
import ExpansionAgent from '../src/agents/ExpansionAgent.js';
import callProvider, { getProviderInfo } from '../src/utils/providers.js';
import os from 'os';
import inquirer from 'inquirer';
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import Piscina from 'piscina';
import GpuOrchestrator, { GPU_EMERGENCY_STOP } from '../src/gpu/orchestrator.js';

// --- API Key Management ---

async function getApiKey() {
    const provider = (process.env.IMLIL_PROVIDER || 'embedapi').toLowerCase();

    const keyEnvVars = {
        embedapi: 'IMLIL_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        custom: 'CUSTOM_API_KEY',
    };

    const envVar = keyEnvVars[provider] || 'IMLIL_API_KEY';
    if (process.env[envVar]) {
        return process.env[envVar];
    }

    if (provider === 'embedapi') {
        const configPath = path.join(os.homedir(), '.imlil');
        try {
            const apiKey = await fs.readFile(configPath, 'utf8');
            return apiKey.trim();
        } catch (error) {
            // fall through to prompt
        }
    }

    const { apiKey } = await inquirer.prompt([
        {
            type: 'password',
            name: 'apiKey',
            message: `Please enter your API key for provider "${provider}" (env: ${envVar}):`,
        },
    ]);
    return apiKey;
}

function showProviderInfo() {
    const info = getProviderInfo();
    const config = {
        embedapi: process.env.IMLIL_API_KEY ? '****' : 'not set',
        openrouter: process.env.OPENROUTER_API_KEY ? '****' : 'not set',
        custom: process.env.CUSTOM_API_KEY ? '****' : 'not set',
    };
    const prov = (process.env.IMLIL_PROVIDER || 'embedapi').toLowerCase();
    console.log(`Provider: ${info}  (key: ${config[prov] || 'not set'})`);
}

// --- Main Application ---

program
    .command('make <project_description>')
    .description('Create a new project by orchestrating agents')
    .option('--debug', 'Enable debug mode to see raw AI responses.')
    .option('--max-agents <num>', 'Set the maximum number of parallel agents.')
    .option('--provider <name>', 'Override provider (embedapi|openrouter|custom).')
    .option('--model <name>', 'Override model name for the active provider.')
    .option('--gpu', 'Use GPU-accelerated agent execution (CUDA). Offloads orchestration to RTX 3070 Ti.')
    .action(async (project_description, options) => {
        if (options.provider) process.env.IMLIL_PROVIDER = options.provider;
        if (options.model) process.env.IMLIL_MODEL = options.model;

        showProviderInfo();

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

        // 10-minute timeout safeguard
        const timeoutId = setTimeout(() => {
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

        const dbPath = path.join(process.cwd(), '.imlil', 'tasks.db');

        await initializeDatabase(dbPath);
        const supervisor = new SupervisorAgent('Supervisor', 'Orchestrates the project', apiKey, config);
        await supervisor.run(project_description);
        
        clearTimeout(timeoutId);
        
        await orchestrator(config, apiKey, projectRoot, dbPath, screen, logBox, agentStatusBox, statsBox, progressBar);
    });

program
    .command('status')
    .description('Check current provider configuration')
    .action(() => {
        showProviderInfo();
        console.log('');
        console.log('Set IMLIL_PROVIDER to one of: embedapi (default), openrouter, custom');
        console.log('Then set the corresponding API key env var.');
        console.log('');
        console.log('Examples:');
        console.log('  IMLIL_PROVIDER=openrouter OPENROUTER_API_KEY=sk-... imlil make "..."');
        console.log('  IMLIL_PROVIDER=custom CUSTOM_API_KEY=sk-... CUSTOM_API_URL=http://... imlil make "..."');
        console.log('  IMLIL_MODEL="deepseek-chat" IMLIL_PROVIDER=custom CUSTOM_API_KEY=... imlil make "..."');
    });

// --- Shared orchestrator with safe TTY guards ---
// All blessed UI calls are null-guarded so non-TTY (pipe) usage works.

async function orchestrator(config, apiKey, projectRoot, dbPath, screen, logBox, agentStatusBox, statsBox, progressBar) {
    const db = getDb();
    const scrumMaster = new ScrumAgent('Scrum Master', 'Manages the task backlog', null, apiKey, config);
    const expansionPlanner = new ExpansionAgent(apiKey, config);
    
    console.log('Orchestrator: Agent army, ATTENTION! MISSION START!');

    const useGPU = !!(process.argv.includes('--gpu') || process.env.IMLIL_GPU === 'true');
    
    // Initialize GPU orchestrator if requested
    let gpuOrch = null;
    if (useGPU) {
        gpuOrch = new GpuOrchestrator({
            deviceIndex: 0,
            maxAgents: config.maxAgents || 10000,
            httpWorkers: 50,
        });
        const gpuReady = await gpuOrch.init();
        if (!gpuReady) {
            console.log('GPU init failed, falling back to CPU Piscina.');
            gpuOrch = null;
        } else {
            const snap = gpuOrch.getSnapshot();
            if (snap) {
                console.log(`GPU Monitor: VRAM ${snap.vramUsedGB.toFixed(1)}/${snap.vramTotalGB.toFixed(1)} GB`);
            }
        }
    }

    if (gpuOrch) {
        // ═══ PURE GPU ORCHESTRATOR ═══
        // Replaces the entire CPU scheduler with GPU batch loops
        console.log('GPU Mode: Pure parallel orchestration active.');
        
        let round = 0;
        const startTime = Date.now();
        let totalSucceeded = 0, totalFailed = 0;
        while (true) {
            // Get ALL pending tasks
            const pendingTasks = await db.all('SELECT * FROM tasks WHERE status = ? ORDER BY id ASC', 'pending');
            
            if (pendingTasks.length === 0) {
                // Check if there are running tasks (tasks that got stuck in 'running' state)
                const runningCount = (await db.all('SELECT count(*) as c FROM tasks WHERE status = ?', 'running'))[0].c;
                if (runningCount === 0 && round > 0) {
                    // No pending, no running — mission complete
                    console.log(`\nGPU: All ${round} rounds complete. ${pendingTasks.length} pending, ${runningCount} running.`);
                    break;
                }
                // Wait and check for new expansion tasks
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            
            round++;
            const roundStart = Date.now();
            console.log(`\n🚀 GPU Round ${round}: ${pendingTasks.length} tasks`);
            
            // Mark all as running in UI
            for (const t of pendingTasks) {
                t.currentActivity = `GPU Round ${round}`;
            }
            
            // Launch ALL pending tasks in one GPU batch call
            const gpuResults = await gpuOrch.run(pendingTasks, apiKey, config);
            
            // Process results
            const completed = [];
            for (const result of gpuResults) {
                if (result.status === 'completed') {
                    completed.push(result);
                } else {
                    const task = pendingTasks.find(t => t.id === result.taskId);
                    if (task) {
                        const retries = (await db.all('SELECT retries FROM tasks WHERE id = ?', task.id))[0]?.retries || 0;
                        if (retries >= 3) {
                            await db.run('UPDATE tasks SET status = ? WHERE id = ?', 'failed', task.id);
                        } else {
                            await db.run('UPDATE tasks SET retries = ?, status = ? WHERE id = ?', retries + 1, 'pending', task.id);
                        }
                    }
                }
            }
            
            console.log(`GPU Round ${round} done: ${completed.length}/${gpuResults.length} succeeded [${(Date.now()-roundStart)/1000}s, ${(Date.now()-startTime)/1000}s total]`);
            totalSucceeded += completed.length;
            totalFailed += (gpuResults.length - completed.length);
            
            // Quick validation — mark completed tasks (fire-and-forget expansions in parallel)
            const expansionPromises = [];
            for (const result of completed) {
                const task = pendingTasks.find(t => t.id === result.taskId);
                if (task) {
                    await db.run('UPDATE tasks SET status = ? WHERE id = ?', 'completed', task.id);
                    expansionPromises.push(
                        expansionPlanner.expandFrom(task, result.filePath, result.filePath)
                            .catch(e => null) // ignore expansion failures
                    );
                }
            }
            await Promise.all(expansionPromises);
            
            // Safety check
            const safety = gpuOrch.getSafety();
            if (safety === GPU_EMERGENCY_STOP) {
                console.error('GPU EMERGENCY STOP — aborting.');
                break;
            }
        }
        
        console.log('\nGPU MISSION COMPLETE!');
        const elapsed = (Date.now() - startTime) / 1000;
        const snap = gpuOrch.getSnapshot();
        console.log(`╔═══════════════════════════════════`);
        console.log(`║ GPU BENCHMARK SUMMARY`);
        console.log(`╠═══════════════════════════════════`);
        console.log(`║ Rounds:        ${round}`);
        console.log(`║ Succeeded:     ${totalSucceeded}`);
        console.log(`║ Failed:        ${totalFailed}`);
        console.log(`║ Total tasks:   ${totalSucceeded + totalFailed}`);
        console.log(`║ Elapsed:       ${elapsed.toFixed(1)}s`);
        console.log(`║ Avg task time: ${elapsed > 0 ? (elapsed / (totalSucceeded + totalFailed || 1)).toFixed(3) : 'N/A'}s`);
        const dbTotal = (await db.all('SELECT count(*) as c FROM tasks'))[0].c;
        console.log(`║ DB total:      ${dbTotal} tasks`);
        if (snap) {
            console.log(`║ GPU VRAM:      ${snap.vramUsedGB.toFixed(2)}/${snap.vramTotalGB.toFixed(1)} GB`);
            console.log(`║ GPU Clock:     ${snap.clockMhz || 'N/A'} MHz`);
        }
        console.log(`╚═══════════════════════════════════`);
        gpuOrch.destroy();
        process.exit(0);
        return;
    }
    
    // ═══ CPU PISCINA ORCHESTRATOR (existing) ═══
    // Piscina (CPU fallback)
    const piscina = new Piscina({
        filename: path.resolve(projectRoot, 'src/agents/worker.js'),
        minThreads: 1,
        maxThreads: config.maxAgents
    });

    const activeTasks = new Map();
    const validationQueue = [];

    const updateAgentStatus = async () => {
        if (logBox && agentStatusBox && statsBox) {
            let content = '{bold}ACTIVE OPERATORS:{/bold}\n';
            let i = 1;
            activeTasks.forEach((task) => {
                const status = task.currentActivity || 'Initializing...';
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

            const pendingCount = (await db.all('SELECT count(*) as count FROM tasks WHERE status = ?', 'pending'))[0].count;
            const completedCount = (await db.all('SELECT count(*) as count FROM tasks WHERE status = ?', 'completed'))[0].count;
            const totalCount = (await db.all('SELECT count(*) as count FROM tasks'))[0].count;

            let statsContent = '';
            statsContent += `{blue-fg}Operators Active: {/blue-fg}${activeTasks.size}/${config.maxAgents}\n`;
            statsContent += `{blue-fg}Validators Active: {/blue-fg}${validationQueue.length > 0 ? 1 : 0}\n`;
            statsContent += `{blue-fg}Tasks: {/blue-fg}${completedCount}/${totalCount} (${pendingCount} pending)\n`;
            statsContent += `{blue-fg}Total Agents: {/blue-fg}${activeTasks.size + (validationQueue.length > 0 ? 1 : 0) + 1}\n`;
            statsBox.setContent(statsContent);

            if (screen) screen.render();
        }
    };

    const processTasks = async () => {
        let isProcessing = false;
        let qaDone = false;

        const scheduler = async () => {
            if (isProcessing) return;
            isProcessing = true;

            try {
                let currentTotalTasks = (await db.all('SELECT count(*) as count FROM tasks'))[0].count;
                let completedTasksCount = (await db.all('SELECT count(*) as count FROM tasks WHERE status = ?', 'completed'))[0].count;
                let pendingTasksCount = (await db.all('SELECT count(*) as count FROM tasks WHERE status = ?', 'pending'))[0].count;
                let failedTasksCount = (await db.all('SELECT count(*) as count FROM tasks WHERE status = ?', 'failed'))[0].count;
                
                if (progressBar) progressBar.filled = (completedTasksCount / currentTotalTasks) * 100;
                await updateAgentStatus();

                if (pendingTasksCount === 0 && activeTasks.size === 0) {
                    if (!qaDone) {
                        qaDone = true;
                        console.log('\nPhase 4: QA & Self-Healing...');

                        try {
                            const { exec } = await import('child_process');
                            const util = await import('util');
                            const execPromise = util.promisify(exec);

                            console.log('Running tests (npm test)...');
                            await execPromise('npm test -- --watchAll=false', { 
                                cwd: process.cwd(),
                                env: { ...process.env, CI: 'true' }
                            });
                            console.log('Tests Passed!');

                            console.log('Running build (npm run build)...');
                            await execPromise('npm run build', { cwd: process.cwd() });
                            console.log('Build Successful!');
                            
                        } catch (error) {
                            const errorOutput = (error.stdout || '') + '\n' + (error.stderr || '') + '\n' + error.message;
                            console.log(`QA Failed! Generating fix task...`);
                            const lastErrors = errorOutput.slice(-2000); 
                            
                            await scrumMaster.addTask(
                                'Fix QA Failure', 
                                `The application failed validation.\nError Log:\n${lastErrors}\n\nAnalyze the error and fix the code.`,
                                []
                            );
                            
                            qaDone = false;
                            return;
                        }
                    }

                    if (progressBar) progressBar.filled = 100;
                    console.log('\nMISSION COMPLETE! ALL TASKS PROCESSED & VERIFIED!');
                    if (screen) screen.render();
                    setTimeout(() => {
                        if (screen) screen.destroy();
                        process.exit(0);
                    }, 3000);
                    return;
                }

                while (activeTasks.size < config.maxAgents) {
                    const nextTask = await scrumMaster.getNextTask();
                    if (!nextTask) break;

                    console.log(`ScrumMaster: Dispatching task "${nextTask.title}" to Operator...`);
                    nextTask.currentActivity = 'Receiving instructions...';
                    activeTasks.set(nextTask.id, nextTask);
                    await updateAgentStatus();

                    // CPU Piscina path
                    piscina.run({ task: nextTask, apiKey, config, dbPath }).then(async (result) => {
                        activeTasks.delete(nextTask.id);
                        // Handle failed/timeout results from worker
                        if (result.status !== 'completed') {
                            // Check retry count before looping forever
                            const retries = nextTask.retries || 0;
                            if (retries >= 3) {
                                console.log(`Task "${nextTask.title}" failed ${retries + 1} times. Marking as failed.`);
                                const db = getDb();
                                await db.run('UPDATE tasks SET status = ?, retries = ? WHERE id = ?', 'failed', retries + 1, nextTask.id);
                                await updateAgentStatus();
                                return;
                            }
                            console.log(`Worker returned status "${result.status}" for task "${nextTask.title}" (retry ${retries + 1}/3): ${result.error || 'Unknown error'}. Re-queuing...`);
                            await scrumMaster.requeueTask(nextTask);
                            await updateAgentStatus();
                            return;
                        }
                        validationQueue.push(result);
                        await updateAgentStatus();
                        handleValidation(); 
                    }).catch(async (err) => {
                        console.error(`CRITICAL ERROR in Worker for task "${nextTask.title}": ${err.message}`);
                        activeTasks.delete(nextTask.id);
                        // Check retry count from DB directly
                        const db = getDb();
                        const dbTask = await db.all('SELECT retries FROM tasks WHERE id = ?', nextTask.id);
                        const currentRetries = (dbTask[0]?.retries || 0) + 1;
                        if (currentRetries >= 3) {
                            console.log(`Task "${nextTask.title}" failed ${currentRetries} times. Marking as failed.`);
                            await db.run('UPDATE tasks SET status = ?, retries = ? WHERE id = ?', 'failed', currentRetries, nextTask.id);
                        } else {
                            console.log(`Re-queuing task "${nextTask.title}" (retry ${currentRetries}/3)...`);
                            await scrumMaster.requeueTask(nextTask);
                        }
                        await updateAgentStatus();
                    }); // end piscina.catch
                }
            } finally {
                isProcessing = false;
            }
        };

        await scheduler();
        setInterval(scheduler, 200); 
    };

    const handleValidation = async () => {
            if (validationQueue.length === 0) return;

            const item = validationQueue.shift();

            if (item.status !== 'completed') {
                console.log(`Worker failed task "${item.task.title}": ${item.error || 'Unknown error'}. Re-queuing...`);
                await scrumMaster.requeueTask(item.task);
                await updateAgentStatus();
                return;
            }

            const { isValid, error } = await ValidatorAgent.validate(item.task, item.testPath);

            if (isValid) {
                console.log(`Validator: Task "${item.task.title}" passes!`);
                await scrumMaster.markTaskAsCompleted(item.task);

                // Feed the army — generate follow-up tasks from completed work
                const newTaskIds = await expansionPlanner.expandFrom(item.task, item.codePath, item.testPath);
                if (newTaskIds.length > 0) {
                    console.log(`Expansion: ${newTaskIds.length} new tasks spawned by "${item.task.title}"`);
                }
            } else {
                console.log(`Validator: REJECTED! Task "${item.task.title}" failed: ${error}. Retrying...`);
                await scrumMaster.requeueTask(item.task);
            }

            await updateAgentStatus();
            handleValidation();
        };

    if (piscina) {
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
                updateAgentStatus();
            }
        }
    });
    }

    await processTasks();
    if (screen) screen.key(['escape', 'q', 'C-c'], () => process.exit(0));
}

program.parse(process.argv);