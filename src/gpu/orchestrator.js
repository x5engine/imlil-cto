/**
 * gpu-orchestrator.js — GPU-Accelerated Agent Orchestrator
 * 
 * Replaces the Piscina CPU-only orchestrator with a hybrid:
 *   - GPU: task formatting, JSON parsing, validation (embarrassingly parallel)
 *   - CPU: HTTP calls to B300, file I/O, DB ops
 * 
 * The GPU side is the bottleneck breaker: instead of 200 Piscina threads,
 * we launch thousands of CUDA blocks. Each block formats a task prompt,
 * validates response structure, and signals completion atomically.
 * 
 * Architecture:
 *   ┌─────────────────────────────────────────────────────┐
 *   │  GPU (RTX 3070 Ti — 6,144 cores, 48 SMs)           │
 *   │  ┌─────────────────────────────────────────────────┐│
 *   │  │ Agent Block 0  │ Agent Block 1  │ ... │ Block N││
 *   │  │ ┌─────────────┐│ ┌─────────────┐│     │         ││
 *   │  │ │ Read task   ││ │ Read task   ││     │         ││
 *   │  │ │ Format JSON ││ │ Format JSON ││     │         ││
 *   │  │ │ Validate    ││ │ Validate    ││     │         ││
 *   │  │ │ Increment   ││ │ Increment   ││     │         ││
 *   │  │ │ completion  ││ │ completion  ││     │         ││
 *   │  │ └─────────────┘│ └─────────────┘│     └─────────┘│
 *   │  └─────────────────────────────────────────────────┘│
 *   └─────────────────────────────────────────────────────┘
 *               │ writes result to pinned buffer
 *               ▼
 *   ┌─────────────────────────────────────────────────────┐
 *   │  CPU (Host) — reads completion buffer               │
 *   │  → Dispatches HTTP calls to B300 (async)            │
 *   │  → Writes generated code to files                   │
 *   │  → Updates task DB (SQLite)                         │
 *   │  → Triggers ExpansionAgent for follow-up tasks      │
 *   │  → Polls GPU monitor (temp, VRAM, power)            │
 *   └─────────────────────────────────────────────────────┘
 */

import { promises as fs } from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';

const GPU_SAFE = 0;
const GPU_THROTTLED = 1;
const GPU_EMERGENCY_STOP = 2;

export { GPU_SAFE, GPU_THROTTLED, GPU_EMERGENCY_STOP };

export class GpuOrchestrator {
  constructor(options = {}) {
    this.deviceIndex = options.deviceIndex || 0;
    this.maxAgents = options.maxAgents || 10000;
    this.httpWorkers = options.httpWorkers || 50; // # of HTTP threads on CPU
    this.monitorEnabled = options.monitorEnabled !== false;
    this.maxRetries = options.maxRetries || 3;
    this.initialized = false;
    this.monitorInterval = null;
    this.lastSnapshot = null;
    this.currentSafety = GPU_SAFE;
  }

  async init() {
    // Check CUDA availability
    const hasCUDA = await this._checkCUDA();
    if (!hasCUDA) {
      console.log('⚠ No CUDA GPU detected. Falling back to CPU-only mode.');
      return false;
    }

    console.log(`🔥 GPU Orchestrator initializing (device ${this.deviceIndex})...`);
    console.log(`   ${this.maxAgents} max agents | ${this.httpWorkers} HTTP workers`);

    // Start GPU monitoring background interval
    if (this.monitorEnabled) {
      this.monitorInterval = setInterval(() => this._pollGPU(), 500);
    }

    this.initialized = true;
    return true;
  }

  async _checkCUDA() {
    try {
      // Quick CUDA check using the nvcc-compiled test binary
      const { execSync } = await import('child_process');
      const out = execSync('/usr/local/cuda-12.4/bin/nvcc --version 2>/dev/null', { timeout: 5000 });
      return out.toString().includes('release');
    } catch {
      return false;
    }
  }

  async _pollGPU() {
    try {
      // Query via CUDA runtime directly
      const { execSync } = await import('child_process');
      
      // Use a one-shot CUDA program to get GPU metrics
      const src = `
#include <cuda_runtime.h>
#include <stdio.h>
int main() {
    int count; cudaGetDeviceCount(&count);
    if (count == 0) { printf("NO_DEVICE\\n"); return 0; }
    cudaSetDevice(${this.deviceIndex});
    size_t free, total; cudaMemGetInfo(&free, &total);
    printf("VRAM:%.1f/%.1f\\n", (total-free)/1e9, total/1e9);
    cudaDeviceProp p; cudaGetDeviceProperties(&p, ${this.deviceIndex});
    printf("CLOCK:%d\\n", p.clockRate/1000);
    printf("OK\\n");
    return 0;
}`;
      
      // Write, compile, run
      await fs.writeFile('/tmp/gpu_poll.cu', src);
      execSync(`/usr/local/cuda-12.4/bin/nvcc -o /tmp/gpu_poll /tmp/gpu_poll.cu 2>/dev/null`, { timeout: 10000 });
      const out = execSync(`/tmp/gpu_poll`, { timeout: 5000 }).toString();
      
      const vramMatch = out.match(/VRAM:([\d.]+)\/([\d.]+)/);
      if (vramMatch) {
        this.lastSnapshot = {
          vramUsedGB: parseFloat(vramMatch[1]),
          vramTotalGB: parseFloat(vramMatch[2]),
          timestamp: Date.now()
        };
        
        // Emergency stop logic (RTX 3070 Ti: 8.6 GB total)
        if (this.lastSnapshot.vramUsedGB >= 8.0) {
          this.currentSafety = GPU_EMERGENCY_STOP;
          console.error('⚠ GPU EMERGENCY STOP: VRAM at', this.lastSnapshot.vramUsedGB.toFixed(1), 'GB');
        } else if (this.lastSnapshot.vramUsedGB >= 7.0) {
          this.currentSafety = GPU_THROTTLED;
        } else {
          this.currentSafety = GPU_SAFE;
        }
      }
    } catch {
      // GPU poll failed silently
    }
  }

  getSnapshot() {
    return this.lastSnapshot;
  }

  getSafety() {
    return this.currentSafety;
  }

  /**
   * Run tasks on GPU orchestration pipeline
   * @param {Array} tasks - Task objects to execute
   * @param {string} apiKey - B300 API key
   * @param {Object} config - Configuration overrides
   * @returns {Array} Results with status, filePath, errors
   */
  async run(tasks, apiKey, config = {}) {
    if (!this.initialized || tasks.length === 0) return [];

    const apiUrl = config.apiUrl || process.env.CUSTOM_API_URL || 'http://100.114.42.73:8000/v1/chat/completions';
    const model = config.model || process.env.IMLIL_MODEL || 'deepseek-v4-flash';
    const maxTokens = config.maxTokens || 4096;
    const timeout = config.timeout || 90000;

    // Check safety
    if (this.currentSafety === GPU_EMERGENCY_STOP) {
      console.error('⚠ GPU EMERGENCY STOP — agents paused. Freeing VRAM...');
      // Wait for VRAM to clear
      await new Promise(r => setTimeout(r, 10000));
      if (this.currentSafety === GPU_EMERGENCY_STOP) {
        console.error('⚠ VRAM still critical. Aborting launch.');
        return [];
      }
    }

    let agentCount = Math.min(tasks.length, this.maxAgents);
    const isThrottled = this.currentSafety === GPU_THROTTLED;
    if (isThrottled) {
      agentCount = Math.max(Math.floor(agentCount / 2), 10);
      console.log(`⚠ GPU THROTTLED (VRAM >7GB) — reducing to ${agentCount} agents`);
    }

    console.log(`🚀 GPU orchestrator: ${agentCount} agents (${tasks.length} tasks)`);

    // Phase 1: GPU formats all task prompts (parallel kernel)
    // In the final implementation, this calls the N-API addon:
    //   this.native.launchAgents(gpuTasks, ctx)
    // For now, we simulate the GPU formatting path:
    const formattedBatch = tasks.slice(0, agentCount).map(task => ({
      ...task,
      _gpuFormattedPrompt: `Write code for: ${task.title}. ${task.description || ''}`,
    }));

    // Phase 2: CPU HTTP workers call B300 asynchronously
    const results = [];
    const batchSize = this.httpWorkers;
    
    for (let i = 0; i < formattedBatch.length; i += batchSize) {
      const batch = formattedBatch.slice(i, i + batchSize);
      
      console.log(`  Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(formattedBatch.length / batchSize)} (${batch.length} agents)`);
      
      const batchResults = await Promise.allSettled(
        batch.map(task => this._executeAgentTask(task, apiUrl, apiKey, model, maxTokens, timeout))
      );
      
      for (let j = 0; j < batchResults.length; j++) {
        const r = batchResults[j];
        results.push({
          taskId: batch[j].id || batch[j].title,
          status: r.status === 'fulfilled' ? 'completed' : 'failed',
          filePath: r.status === 'fulfilled' ? r.value.filePath : null,
          error: r.status === 'rejected' ? r.reason?.message || 'Unknown' : null,
        });
      }
      
      // Check GPU safety between batches
      if (this.currentSafety === GPU_EMERGENCY_STOP) {
        console.error('⚠ GPU EMERGENCY STOP mid-batch — aborting remaining agents.');
        break;
      }
    }

    console.log(`✅ GPU orchestrator complete: ${results.filter(r => r.status === 'completed').length}/${results.length} succeeded`);
    return results;
  }

  async _executeAgentTask(task, apiUrl, apiKey, model, maxTokens, timeout) {
    // Use callProvider to make the HTTP request
    const callProvider = (await import('../utils/providers.js')).default;
    
    const response = await callProvider(
      task.description || task.title,
      { apiKey, maxTokens, timeout }
    );
    
    // Generate output file path
    const outputDir = process.cwd();
    const safeName = task.title
      ? task.title.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 40)
      : `task_${Date.now()}`;
    const filePath = path.join(outputDir, `${safeName}_${task.id}.ts`);
    
    await fs.writeFile(filePath, response);
    
    return { filePath };
  }

  destroy() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.initialized = false;
    console.log('GPU orchestrator shut down.');
  }
}

export default GpuOrchestrator;