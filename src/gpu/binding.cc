/*
 * gpu_binding.c — Node.js N-API Addon for GPU Agent Orchestration
 * 
 * Exposes:
 *   - gpu.init(deviceIndex)           → Initialize GPU + monitor
 *   - gpu.getSnapshot()               → Current GPU vitals (temp, VRAM, power)
 *   - gpu.getSafety()                  → SAFE / THROTTLED / EMERGENCY_STOP
 *   - gpu.launchAgents(tasks, ctx)     → Launch N agents on GPU
 *   - gpu.destroy()                    → Cleanup
 */

#include <assert.h>
#include <node_api.h>
#include <string.h>
#include <stdlib.h>

#include "../cuda/agent_launcher.cu"  // Includes the CUDA kernel + host launcher
#include "../include/gpu_monitor.h"   // GPU safety monitor

/* ——— Global state ——— */
static GpuMonitor* g_monitor = NULL;
static int g_initialized = 0;
static int g_device_index = 0;

/* ——— Error helper ——— */
#define NAPI_THROW_ERR(msg) \
    napi_throw_error(env, NULL, msg); \
    return NULL;

#define NAPI_CHECK(call) \
    if ((call) != napi_ok) { \
        napi_throw_error(env, NULL, "N-API call failed"); \
        return NULL; \
    }

/* ——— init(deviceIndex) ——— */
static napi_value gpu_init(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    NAPI_CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
    
    int device_index = 0;
    if (argc >= 1) {
        napi_get_value_int32(env, args[0], &device_index);
    }
    
    if (g_initialized) {
        NAPI_THROW_ERR("GPU already initialized. Call destroy() first.");
    }
    
    // Check CUDA device count
    int count;
    cudaError_t err = cudaGetDeviceCount(&count);
    if (err != cudaSuccess || count == 0) {
        napi_throw_error(env, NULL, "No CUDA-capable GPU found");
        return NULL;
    }
    
    if (device_index >= count) {
        napi_throw_error(env, NULL, "Device index out of range");
        return NULL;
    }
    
    cudaDeviceProp prop;
    cudaGetDeviceProperties(&prop, device_index);
    
    // Start monitor
    g_monitor = gpu_monitor_create(device_index);
    if (!g_monitor) {
        napi_throw_error(env, NULL, "Failed to create GPU monitor");
        return NULL;
    }
    gpu_monitor_start(g_monitor);
    
    g_device_index = device_index;
    g_initialized = 1;
    
    // Return device info
    napi_value result;
    NAPI_CHECK(napi_create_object(env, &result));
    
    napi_value name_val;
    NAPI_CHECK(napi_create_string_utf8(env, prop.name, NAPI_AUTO_LENGTH, &name_val));
    NAPI_CHECK(napi_set_named_property(env, result, "name", name_val));
    
    napi_value vram_val;
    NAPI_CHECK(napi_create_double(env, prop.totalGlobalMem / 1e9, &vram_val));
    NAPI_CHECK(napi_set_named_property(env, result, "vramGB", vram_val));
    
    napi_value sms_val;
    NAPI_CHECK(napi_create_int32(env, prop.multiProcessorCount, &sms_val));
    NAPI_CHECK(napi_set_named_property(env, result, "sms", sms_val));
    
    napi_value compute_val;
    char comp_str[16];
    snprintf(comp_str, 16, "%d.%d", prop.major, prop.minor);
    napi_value comp_napi;
    NAPI_CHECK(napi_create_string_utf8(env, comp_str, NAPI_AUTO_LENGTH, &comp_napi));
    NAPI_CHECK(napi_set_named_property(env, result, "computeCapability", comp_napi));
    
    return result;
}

/* ——— getSnapshot() ——— */
static napi_value gpu_get_snapshot(napi_env env, napi_callback_info info) {
    if (!g_initialized || !g_monitor) {
        NAPI_THROW_ERR("GPU not initialized. Call init() first.");
    }
    
    GpuSnapshot snap = gpu_monitor_get_snapshot(g_monitor);
    
    napi_value result;
    NAPI_CHECK(napi_create_object(env, &result));
    
    napi_value temp;
    NAPI_CHECK(napi_create_double(env, snap.temp_c, &temp));
    NAPI_CHECK(napi_set_named_property(env, result, "temperatureC", temp));
    
    napi_value power;
    NAPI_CHECK(napi_create_double(env, snap.power_w, &power));
    NAPI_CHECK(napi_set_named_property(env, result, "powerW", power));
    
    napi_value vram_used;
    NAPI_CHECK(napi_create_double(env, snap.vram_used_gb, &vram_used));
    NAPI_CHECK(napi_set_named_property(env, result, "vramUsedGB", vram_used));
    
    napi_value vram_total;
    NAPI_CHECK(napi_create_double(env, snap.vram_total_gb, &vram_total));
    NAPI_CHECK(napi_set_named_property(env, result, "vramTotalGB", vram_total));
    
    napi_value util;
    NAPI_CHECK(napi_create_double(env, snap.gpu_util_pct, &util));
    NAPI_CHECK(napi_set_named_property(env, result, "gpuUtilPct", util));
    
    napi_value clock;
    NAPI_CHECK(napi_create_int32(env, snap.clock_mhz, &clock));
    NAPI_CHECK(napi_set_named_property(env, result, "clockMHz", clock));
    
    return result;
}

/* ——— getSafety() ——— */
static napi_value gpu_get_safety(napi_env env, napi_callback_info info) {
    if (!g_initialized || !g_monitor) {
        NAPI_THROW_ERR("GPU not initialized.");
    }
    
    GpuSafetyLevel s = gpu_monitor_get_safety(g_monitor);
    
    napi_value result;
    NAPI_CHECK(napi_create_int32(env, (int)s, &result));
    return result;
}

/* ——— launchAgents(tasks, ctx) ——— 
 * 
 * tasks: Array of { taskId, title, description, dependencies }
 * ctx:   { apiUrl, apiKey, model, maxTokens, timeoutMs, maxAgents }
 */
static napi_value gpu_launch_agents(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    NAPI_CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
    
    if (!g_initialized) {
        NAPI_THROW_ERR("GPU not initialized. Call init() first.");
    }
    
    // Check safety
    GpuSafetyLevel safety = gpu_monitor_get_safety(g_monitor);
    if (safety == GPU_EMERGENCY_STOP) {
        napi_throw_error(env, NULL, "EMERGENCY STOP: GPU limits exceeded");
        return NULL;
    }
    
    // Parse tasks array
    bool is_array;
    NAPI_CHECK(napi_is_array(env, args[0], &is_array));
    if (!is_array) {
        NAPI_THROW_ERR("tasks must be an array");
    }
    
    uint32_t num_tasks;
    NAPI_CHECK(napi_get_array_length(env, args[0], &num_tasks));
    
    if (num_tasks == 0) {
        napi_value empty;
        NAPI_CHECK(napi_create_array(env, &empty));
        return empty;
    }
    
    // Parse context
    napi_value ctx = args[1];
    char api_url[256] = "http://100.114.42.73:8000/v1/chat/completions";
    char api_key[64] = "";
    char model[64] = "deepseek-v4-flash";
    int max_tokens = 4096;
    int timeout_ms = 90000;
    int max_agents = (int)num_tasks;
    
    napi_value val;
    
    if (napi_get_named_property(env, ctx, "apiUrl", &val) == napi_ok) {
        size_t len;
        napi_get_value_string_utf8(env, val, api_url, 255, &len);
    }
    if (napi_get_named_property(env, ctx, "apiKey", &val) == napi_ok) {
        size_t len;
        napi_get_value_string_utf8(env, val, api_key, 63, &len);
    }
    if (napi_get_named_property(env, ctx, "model", &val) == napi_ok) {
        size_t len;
        napi_get_value_string_utf8(env, val, model, 63, &len);
    }
    if (napi_get_named_property(env, ctx, "maxTokens", &val) == napi_ok) {
        napi_get_value_int32(env, val, &max_tokens);
    }
    if (napi_get_named_property(env, ctx, "timeoutMs", &val) == napi_ok) {
        napi_get_value_int32(env, val, &timeout_ms);
    }
    if (napi_get_named_property(env, ctx, "maxAgents", &val) == napi_ok) {
        napi_get_value_int32(env, val, &max_agents);
    }
    
    // Clamp max_agents
    if (max_agents > MAX_AGENTS_PER_LAUNCH) max_agents = MAX_AGENTS_PER_LAUNCH;
    if (max_agents > (int)num_tasks) max_agents = (int)num_tasks;
    
    // Allocate pinned host memory for tasks and results
    GpuTask *h_tasks;
    GpuAgentResult *h_results;
    uint64_t h_counter = 0;
    
    cudaError_t err;
    err = cudaHostAlloc(&h_tasks, num_tasks * sizeof(GpuTask), cudaHostAllocDefault);
    if (err != cudaSuccess) {
        napi_throw_error(env, NULL, "Failed to allocate pinned task memory");
        return NULL;
    }
    
    err = cudaHostAlloc(&h_results, max_agents * sizeof(GpuAgentResult), cudaHostAllocDefault);
    if (err != cudaSuccess) {
        cudaFreeHost(h_tasks);
        napi_throw_error(env, NULL, "Failed to allocate pinned result memory");
        return NULL;
    }
    
    // Fill task array from JS
    memset(h_tasks, 0, num_tasks * sizeof(GpuTask));
    
    for (uint32_t i = 0; i < num_tasks; i++) {
        napi_value task_obj;
        NAPI_CHECK(napi_get_element(env, args[0], i, &task_obj));
        
        napi_value tid_val;
        if (napi_get_named_property(env, task_obj, "taskId", &tid_val) == napi_ok) {
            napi_get_value_int64(env, tid_val, (int64_t*)&h_tasks[i].task_id);
        } else {
            h_tasks[i].task_id = i + 1;
        }
        
        napi_value title_val;
        if (napi_get_named_property(env, task_obj, "title", &title_val) == napi_ok) {
            size_t len;
            napi_get_value_string_utf8(env, title_val, h_tasks[i].title, MAX_TASK_TITLE_LEN - 1, &len);
        }
        
        napi_value desc_val;
        if (napi_get_named_property(env, task_obj, "description", &desc_val) == napi_ok) {
            size_t len;
            napi_get_value_string_utf8(env, desc_val, h_tasks[i].description, MAX_TASK_DESC_LEN - 1, &len);
        }
        
        napi_value deps_val;
        if (napi_get_named_property(env, task_obj, "dependencies", &deps_val) == napi_ok) {
            bool is_deps_array;
            napi_is_array(env, deps_val, &is_deps_array);
            if (is_deps_array) {
                uint32_t dep_count;
                napi_get_array_length(env, deps_val, &dep_count);
                h_tasks[i].dependency_count = (int)dep_count;
                
                // Build JSON string for dependencies
                char dep_str[128] = "[";
                int pos = 1;
                for (uint32_t d = 0; d < dep_count && pos < 120; d++) {
                    napi_value dep_id;
                    napi_get_element(env, deps_val, d, &dep_id);
                    int64_t did;
                    if (napi_get_value_int64(env, dep_id, &did) == napi_ok) {
                        if (d > 0) dep_str[pos++] = ',';
                        char num[32];
                        int ni = snprintf(num, 32, "%lld", (long long)did);
                        for (int k = 0; k < ni && pos < 126; k++) dep_str[pos++] = num[k];
                    }
                }
                dep_str[pos] = ']';
                dep_str[pos + 1] = '\0';
                strncpy(h_tasks[i].dependencies, dep_str, 127);
            }
        }
        
        h_tasks[i].status = 0; // pending
    }
    
    // Launch on GPU
    int launch_result = launch_agents(
        h_tasks, h_results, &h_counter,
        num_tasks, max_agents,
        api_url, api_key, model, max_tokens, timeout_ms
    );
    
    // Build JS results array
    napi_value js_results;
    NAPI_CHECK(napi_create_array(env, &js_results));
    
    uint32_t result_count = (uint32_t)(h_counter < (uint64_t)max_agents ? h_counter : (uint64_t)max_agents);
    
    for (uint32_t i = 0; i < result_count; i++) {
        napi_value item;
        NAPI_CHECK(napi_create_object(env, &item));
        
        napi_value id;
        NAPI_CHECK(napi_create_int64(env, (int64_t)h_results[i].task_id, &id));
        NAPI_CHECK(napi_set_named_property(env, item, "taskId", id));
        
        napi_value status;
        NAPI_CHECK(napi_create_int32(env, h_results[i].status, &status));
        NAPI_CHECK(napi_set_named_property(env, item, "status", status));
        
        napi_value path;
        NAPI_CHECK(napi_create_string_utf8(env, h_results[i].file_path, NAPI_AUTO_LENGTH, &path));
        NAPI_CHECK(napi_set_named_property(env, item, "filePath", path));
        
        NAPI_CHECK(napi_set_element(env, js_results, i, item));
    }
    
    // Cleanup pinned memory
    cudaFreeHost(h_tasks);
    cudaFreeHost(h_results);
    
    return js_results;
}

/* ——— destroy() ——— */
static napi_value gpu_destroy(napi_env env, napi_callback_info info) {
    if (g_monitor) {
        gpu_monitor_destroy(g_monitor);
        g_monitor = NULL;
    }
    g_initialized = 0;
    
    napi_value result;
    NAPI_CHECK(napi_get_undefined(env, &result));
    return result;
}

/* ——— Module exports ——— */
static napi_value gpu_init_module(napi_env env, napi_value exports) {
    napi_value fn_init, fn_snapshot, fn_safety, fn_launch, fn_destroy;
    
    NAPI_CHECK(napi_create_function(env, "init", NAPI_AUTO_LENGTH, gpu_init, NULL, &fn_init));
    NAPI_CHECK(napi_set_named_property(env, exports, "init", fn_init));
    
    NAPI_CHECK(napi_create_function(env, "getSnapshot", NAPI_AUTO_LENGTH, gpu_get_snapshot, NULL, &fn_snapshot));
    NAPI_CHECK(napi_set_named_property(env, exports, "getSnapshot", fn_snapshot));
    
    NAPI_CHECK(napi_create_function(env, "getSafety", NAPI_AUTO_LENGTH, gpu_get_safety, NULL, &fn_safety));
    NAPI_CHECK(napi_set_named_property(env, exports, "getSafety", fn_safety));
    
    NAPI_CHECK(napi_create_function(env, "launchAgents", NAPI_AUTO_LENGTH, gpu_launch_agents, NULL, &fn_launch));
    NAPI_CHECK(napi_set_named_property(env, exports, "launchAgents", fn_launch));
    
    NAPI_CHECK(napi_create_function(env, "destroy", NAPI_AUTO_LENGTH, gpu_destroy, NULL, &fn_destroy));
    NAPI_CHECK(napi_set_named_property(env, exports, "destroy", fn_destroy));
    
    // Export safety level constants
    napi_value safe, throttled, emergency;
    NAPI_CHECK(napi_create_int32(env, 0, &safe));
    NAPI_CHECK(napi_set_named_property(env, exports, "SAFE", safe));
    NAPI_CHECK(napi_create_int32(env, 1, &throttled));
    NAPI_CHECK(napi_set_named_property(env, exports, "THROTTLED", throttled));
    NAPI_CHECK(napi_create_int32(env, 2, &emergency));
    NAPI_CHECK(napi_set_named_property(env, exports, "EMERGENCY_STOP", emergency));
    
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, gpu_init_module);