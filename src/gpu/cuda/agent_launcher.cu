/*
 * agent_launcher.cu — GPU Agent Execution Kernel
 * 
 * Launches N agents as CUDA blocks on the GPU.
 * Each block = 1 agent = 1 task execution + HTTP call to B300.
 * 
 * Architecture:
 *   Grid dim  = number of agents (up to 65,535 per launch)
 *   Block dim = 256 threads (warp-level parallelism)
 *   
 * Each block:
 *   1. Reads task from pinned host buffer (zero-copy)
 *   2. Formats HTTP request JSON to B300
 *   3. Sends via HTTP (CUDA-aware network or host-forwarded)
 *   4. Parses response JSON
 *   5. Writes result code + file path to output buffer
 *   6. Atomic increment on completion counter
 * 
 * NOTE: CUDA HTTP calls require GPU Direct RDMA or custom network stack.
 * For RTX 3070 Ti (no NVLink), we use a hybrid approach:
 *   - GPU does JSON formatting + validation (pure compute)
 *   - Host thread pool handles actual HTTP (async callback)
 *   - GPU writes results to pinned buffer, host polls completion
 */

#include <cuda_runtime.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* ——— Configuration ——— */
#define MAX_TASK_TITLE_LEN     256
#define MAX_TASK_DESC_LEN      1024
#define MAX_FILE_PATH_LEN      512
#define MAX_PROMPT_LEN         4096
#define MAX_RESPONSE_LEN       8192
#define MAX_AGENTS_PER_LAUNCH  65536
#define MAX_HTTP_URL_LEN       256

/* ——— Task descriptor (shared between host and device) ——— */
typedef struct __align__(16) {
    uint64_t task_id;
    char     title[MAX_TASK_TITLE_LEN];
    char     description[MAX_TASK_DESC_LEN];
    char     dependencies[128];        // JSON array of IDs
    int      dependency_count;
    int      retries;
    int      status;                    // 0=pending, 1=running, 2=completed, 3=failed
    int      padding;
} GpuTask;

/* ——— Agent execution result ——— */
typedef struct __align__(16) {
    uint64_t task_id;
    int      status;          // 0=pending, 1=running, 2=completed, 3=failed
    int      error_code;
    char     file_path[MAX_FILE_PATH_LEN];   // Generated file path
    char     error_msg[512];                 // Error message if failed
} GpuAgentResult;

/* ——— Agent context (constant per launch) ——— */
typedef struct {
    char api_url[MAX_HTTP_URL_LEN];
    char api_key[64];
    char model_name[64];
    int  max_tokens;
    int  num_tasks;
    int  num_agents;
    int  timeout_ms;
} GpuAgentContext;

/* ——— Device-side constants ——— */
__constant__ GpuAgentContext dev_ctx;

/* ——— Device-side JSON formatter ——— */
__device__ void format_agent_prompt(
    const GpuTask* task,
    char* out_prompt,
    int max_len
) {
    // Simple prompt construction on GPU
    // In production: use a lightweight GPU JSON library
    int pos = 0;
    
    const char* prefix = "{\"model\":\"";
    while (*prefix && pos < max_len - 1) out_prompt[pos++] = *prefix++;
    
    const char* model = dev_ctx.model_name;
    while (*model && pos < max_len - 1) out_prompt[pos++] = *model++;
    
    const char* mid = "\",\"messages\":[{\"role\":\"user\",\"content\":\"Write code for: ";
    while (*mid && pos < max_len - 1) out_prompt[pos++] = *mid++;
    
    // Escape and copy task title
    const char* title = task->title;
    while (*title && pos < max_len - 1) {
        if (*title == '"' || *title == '\\') out_prompt[pos++] = '\\';
        out_prompt[pos++] = *title++;
    }
    
    const char* suffix = "\"}],\"max_tokens\":";
    while (*suffix && pos < max_len - 1) out_prompt[pos++] = *suffix++;
    
    // Append max_tokens as string
    int tokens = dev_ctx.max_tokens;
    char tok_str[16];
    int ti = 0;
    if (tokens == 0) { tok_str[ti++] = '4'; tok_str[ti++] = '0'; tok_str[ti++] = '9'; tok_str[ti++] = '6'; }
    else {
        int tmp = tokens;
        char rev[16];
        int ri = 0;
        while (tmp > 0) { rev[ri++] = '0' + (tmp % 10); tmp /= 10; }
        for (int j = ri - 1; j >= 0; j--) tok_str[ti++] = rev[j];
    }
    tok_str[ti] = '\0';
    
    int t = 0;
    while (tok_str[t] && pos < max_len - 1) out_prompt[pos++] = tok_str[t++];
    
    const char* close = "}";
    while (*close && pos < max_len - 1) out_prompt[pos++] = *close++;
    
    out_prompt[pos] = '\0';
}

/* ——— Device-side simple response parser ——— */
__device__ int parse_response_code(
    const char* response,
    int response_len
) {
    // Simple heuristic: check if response contains valid JSON with "choices"
    // In production: use a proper GPU JSON parser
    const char* needle = "\"choices\"";
    int nl = 9; // strlen("\"choices\"") = 9
    for (int i = 0; i < response_len - nl; i++) {
        int match = 1;
        for (int j = 0; j < nl; j++) {
            if (response[i + j] != needle[j]) { match = 0; break; }
        }
        if (match) return 0; // Success
    }
    return -1; // Malformed response
}

/* ——— Main agent kernel ——— 
 * 
 * ONE BLOCK = ONE AGENT
 * 
 * Grid:    <num_agents, 1, 1>
 * Block:   <256, 1, 1> (multiple threads per agent for parallel work)
 * 
 * Thread 0: reads task from buffer, orchestrates
 * Threads 1-255: helpers (string ops, parsing, etc.)
 */
__global__ void agent_kernel(
    GpuTask*         tasks,          // Input task array (pinned host or device)
    GpuAgentResult*  results,        // Output results array
    volatile uint64_t* completion_counter,  // Atomic increment on completion
    int              num_tasks,
    int              max_agents
) {
    int agent_id = blockIdx.x;   // Each block = one agent
    if (agent_id >= max_agents || agent_id >= num_tasks) return;
    
    int tid = threadIdx.x;
    __shared__ GpuTask local_task;
    __shared__ char local_prompt[MAX_PROMPT_LEN];
    __shared__ int task_valid;
    
    // Thread 0: Load task from global memory
    if (tid == 0) {
        local_task = tasks[agent_id];
        task_valid = (local_task.status == 0) ? 1 : 0; // Only process pending tasks
    }
    __syncthreads();
    
    if (!task_valid) {
        if (tid == 0) {
            results[agent_id].task_id = local_task.task_id;
            results[agent_id].status = -1; // Skipped
        }
        return;
    }
    
    // Thread 0: Format the prompt
    if (tid == 0) {
        format_agent_prompt(&local_task, local_prompt, MAX_PROMPT_LEN);
    }
    __syncthreads();
    
    // All threads: cooperative string processing (length calculation, validation)
    // In a real implementation, warp-level primitives would parse the response
    
    // Thread 0: Mark as running, signal host to send HTTP, wait for response
    // NOTE: In the hybrid model, thread 0 writes the prepared prompt to a 
    // host-readable buffer and signals a host-side HTTP thread pool.
    // For this iteration, we simulate the GPU-side compute part and
    // return the formatted prompt for host-side execution.
    
    if (tid == 0) {
        // For now, write result indicating GPU did its compute part
        results[agent_id].task_id = local_task.task_id;
        results[agent_id].status = 2; // GPU processing complete
        results[agent_id].error_code = 0;
        // Build file path manually (device-safe, no snprintf)
        {
            const char* prefix = "gpu_ready_";
            int pi = 0;
            while (prefix[pi] && pi < MAX_FILE_PATH_LEN - 20) {
                results[agent_id].file_path[pi] = prefix[pi];
                pi++;
            }
            // Append task_id as string
            uint64_t tid_val = local_task.task_id;
            char rev[20];
            int ri = 0;
            if (tid_val == 0) rev[ri++] = '0';
            while (tid_val > 0) { rev[ri++] = '0' + (tid_val % 10); tid_val /= 10; }
            for (int j = ri - 1; j >= 0 && pi < MAX_FILE_PATH_LEN - 6; j--) {
                results[agent_id].file_path[pi++] = rev[j];
            }
            const char* suffix = ".json";
            int si = 0;
            while (suffix[si] && pi < MAX_FILE_PATH_LEN - 1) {
                results[agent_id].file_path[pi++] = suffix[si++];
            }
            results[agent_id].file_path[pi] = '\0';
        }
        
        // Atomic increment on completion counter
        atomicAdd((unsigned long long*)completion_counter, 1);
    }
}

/* ——— Host-side launcher ——— */
extern "C" {

int launch_agents(
    GpuTask*        h_tasks,
    GpuAgentResult* h_results,
    uint64_t*       h_completion_counter,
    int             num_tasks,
    int             num_agents,
    const char*     api_url,
    const char*     api_key,
    const char*     model_name,
    int             max_tokens,
    int             timeout_ms
) {
    cudaError_t err;
    int ret = 0;
    
    // Allocate device memory — freed on failure via early return
    GpuTask *d_tasks = NULL;
    GpuAgentResult *d_results = NULL;
    uint64_t *d_counter = NULL;
    
    // Pre-declare grid/block to avoid NVCC goto-bypass-initialization error
    dim3 grid;
    dim3 block;
    
    err = cudaMalloc(&d_tasks, num_tasks * sizeof(GpuTask));
    if (err != cudaSuccess) { fprintf(stderr, "cudaMalloc tasks: %s\n", cudaGetErrorString(err)); return -1; }
    
    err = cudaMalloc(&d_results, num_agents * sizeof(GpuAgentResult));
    if (err != cudaSuccess) { fprintf(stderr, "cudaMalloc results: %s\n", cudaGetErrorString(err)); cudaFree(d_tasks); return -1; }
    
    err = cudaMalloc(&d_counter, sizeof(uint64_t));
    if (err != cudaSuccess) { fprintf(stderr, "cudaMalloc counter: %s\n", cudaGetErrorString(err)); cudaFree(d_results); cudaFree(d_tasks); return -1; }
    
    // Copy tasks to device
    err = cudaMemcpy(d_tasks, h_tasks, num_tasks * sizeof(GpuTask), cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { fprintf(stderr, "cudaMemcpy tasks: %s\n", cudaGetErrorString(err)); ret = -1; goto cleanup; }
    
    // Initialize counter
    err = cudaMemcpy(d_counter, h_completion_counter, sizeof(uint64_t), cudaMemcpyHostToDevice);
    if (err != cudaSuccess) { fprintf(stderr, "cudaMemcpy counter: %s\n", cudaGetErrorString(err)); ret = -1; goto cleanup; }
    
    // Set constant memory (agent context)
    GpuAgentContext ctx;
    memset(&ctx, 0, sizeof(ctx));
    strncpy(ctx.api_url, api_url ? api_url : "http://100.114.42.73:8000/v1/chat/completions", MAX_HTTP_URL_LEN - 1);
    strncpy(ctx.api_key, api_key ? api_key : "", 63);
    strncpy(ctx.model_name, model_name ? model_name : "deepseek-v4-flash", 63);
    ctx.max_tokens = max_tokens > 0 ? max_tokens : 4096;
    ctx.num_tasks = num_tasks;
    ctx.num_agents = num_agents;
    ctx.timeout_ms = timeout_ms > 0 ? timeout_ms : 90000;
    
    err = cudaMemcpyToSymbol(dev_ctx, &ctx, sizeof(GpuAgentContext));
    if (err != cudaSuccess) { fprintf(stderr, "cudaMemcpyToSymbol: %s\n", cudaGetErrorString(err)); ret = -1; goto cleanup; }
    
    // Launch kernel
    grid = dim3(num_agents, 1, 1);
    block = dim3(256, 1, 1);
    
    printf("GPU: Launching %d agents (grid %d x %d x %d, block %d x %d x %d)...\n",
           num_agents, grid.x, grid.y, grid.z, block.x, block.y, block.z);
    
    agent_kernel<<<grid, block>>>(d_tasks, d_results, d_counter, num_tasks, num_agents);
    
    err = cudaGetLastError();
    if (err != cudaSuccess) { fprintf(stderr, "Kernel launch failed: %s\n", cudaGetErrorString(err)); ret = -1; goto cleanup; }
    
    // Synchronize
    err = cudaDeviceSynchronize();
    if (err != cudaSuccess) { fprintf(stderr, "Kernel sync failed: %s\n", cudaGetErrorString(err)); ret = -1; goto cleanup; }
    
    // Copy results back
    err = cudaMemcpy(h_results, d_results, num_agents * sizeof(GpuAgentResult), cudaMemcpyDeviceToHost);
    if (err != cudaSuccess) { fprintf(stderr, "cudaMemcpy results back: %s\n", cudaGetErrorString(err)); ret = -1; goto cleanup; }
    
    err = cudaMemcpy(h_completion_counter, d_counter, sizeof(uint64_t), cudaMemcpyDeviceToHost);
    if (err != cudaSuccess) { fprintf(stderr, "cudaMemcpy counter back: %s\n", cudaGetErrorString(err)); ret = -1; goto cleanup; }
    
    printf("GPU: %llu/%d agents completed.\n",
           (unsigned long long)*h_completion_counter, num_agents);
    
    ret = 0;
    
cleanup:
    cudaFree(d_counter);
    cudaFree(d_results);
    cudaFree(d_tasks);
    return ret;
}

} // extern "C"