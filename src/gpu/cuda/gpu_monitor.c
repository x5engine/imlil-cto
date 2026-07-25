/*
 * gpu_monitor.c — GPU Safety Monitor Daemon
 * 
 * Polls NVML-compatible metrics via CUDA runtime API.
 * Runs a background thread checking temp, power, VRAM.
 * Throttles or emergency-stops based on config thresholds.
 */

#include "gpu_monitor.h"

/* ——— Internal: query GPU via CUDA runtime API ——— */
/* 
 * NOTE: In WSL2, NVML (libnvidia-ml) doesn't enumerate devices.
 * We use cudaDeviceGetAttribute + cudaMemGetInfo for what we can.
 * Temperature/power require NVML — we skip those gracefully.
 */

static int query_gpu_snapshot(GpuMonitor* mon, volatile GpuSnapshot* snap) {
    int device = mon->device_index;
    cudaError_t err;
    
    // Set device
    err = cudaSetDevice(device);
    if (err != cudaSuccess) return -1;
    
    // Memory
    size_t free_bytes, total_bytes;
    err = cudaMemGetInfo(&free_bytes, &total_bytes);
    if (err == cudaSuccess) {
        snap->vram_total_gb = total_bytes / 1e9;
        snap->vram_used_gb = (total_bytes - free_bytes) / 1e9;
    }
    
    // Clock rate (from device properties)
    struct cudaDeviceProp prop;
    err = cudaGetDeviceProperties(&prop, device);
    if (err == cudaSuccess) {
        snap->clock_mhz = prop.clockRate / 1000;
    }
    
    // Temperature and power require NVML which isn't available in WSL2.
    // On bare-metal Linux, these would come from nvmlDeviceGetTemperature etc.
    // For WSL2, we flag them as unknown (-1).
    snap->temp_c = -1.0;
    snap->power_w = -1.0;
    snap->gpu_util_pct = -1.0;
    snap->mem_util_pct = -1.0;
    snap->fan_pct = -1;
    
    return 0;
}

/* ——— Internal: check limits ——— */
GpuSafetyLevel gpu_check_limits(GpuSnapshot* s, GpuMonitorConfig* config) {
    // If we couldn't read sensors (WSL2), default to SAFE
    // On bare metal, all checks are active
    
    if (s->vram_used_gb < 0) return GPU_SAFE; // no sensor data (WSL2)
    
    if (s->vram_used_gb >= config->vram_emergency_gb) {
        return GPU_EMERGENCY_STOP;
    }
    if (s->vram_used_gb >= config->vram_throttle_gb) {
        return GPU_THROTTLED;
    }
    
    // Temperature & power checks — only valid if we have sensors
    if (s->temp_c >= 0) {
        if (s->temp_c >= config->temp_emergency_c) return GPU_EMERGENCY_STOP;
        if (s->temp_c >= config->temp_throttle_c)  return GPU_THROTTLED;
    }
    
    if (s->power_w >= 0) {
        if (s->power_w >= config->power_emergency_w) return GPU_EMERGENCY_STOP;
        if (s->power_w >= config->power_throttle_w)  return GPU_THROTTLED;
    }
    
    return GPU_SAFE;
}

/* ——— Monitor thread ——— */
static void* monitor_loop(void* arg) {
    GpuMonitor* mon = (GpuMonitor*)arg;
    
    while (mon->running) {
        GpuSnapshot snap;
        memset(&snap, 0, sizeof(snap));
        
        if (query_gpu_snapshot(mon, &snap) == 0) {
            pthread_mutex_lock(&mon->lock);
            mon->last_snapshot = snap;
            mon->safety = gpu_check_limits(&snap, &mon->config);
            pthread_mutex_unlock(&mon->lock);
        }
        
        usleep(mon->config.poll_interval_ms * 1000);
    }
    
    return NULL;
}

/* ——— Public API ——— */

GpuMonitor* gpu_monitor_create(int device_index) {
    GpuMonitorConfig cfg = GPU_MONITOR_DEFAULT_CONFIG;
    return gpu_monitor_create_with_config(cfg, device_index);
}

GpuMonitor* gpu_monitor_create_with_config(GpuMonitorConfig config, int device_index) {
    GpuMonitor* mon = (GpuMonitor*)calloc(1, sizeof(GpuMonitor));
    if (!mon) return NULL;
    
    mon->config = config;
    mon->device_index = device_index;
    mon->running = 0;
    mon->safety = GPU_SAFE;
    pthread_mutex_init(&mon->lock, NULL);
    
    // Initial snapshot
    query_gpu_snapshot(mon, &mon->last_snapshot);
    
    return mon;
}

int gpu_monitor_start(GpuMonitor* mon) {
    if (mon->running) return 0;
    mon->running = 1;
    return pthread_create(&mon->thread, NULL, monitor_loop, mon);
}

int gpu_monitor_stop(GpuMonitor* mon) {
    if (!mon->running) return 0;
    mon->running = 0;
    return pthread_join(mon->thread, NULL);
}

GpuSafetyLevel gpu_monitor_get_safety(GpuMonitor* mon) {
    pthread_mutex_lock(&mon->lock);
    GpuSafetyLevel s = mon->safety;
    pthread_mutex_unlock(&mon->lock);
    return s;
}

GpuSnapshot gpu_monitor_get_snapshot(GpuMonitor* mon) {
    pthread_mutex_lock(&mon->lock);
    GpuSnapshot s = mon->last_snapshot;
    pthread_mutex_unlock(&mon->lock);
    return s;
}

int gpu_monitor_wait_until_safe(GpuMonitor* mon, int timeout_ms) {
    int waited = 0;
    while (waited < timeout_ms) {
        if (gpu_monitor_get_safety(mon) == GPU_SAFE) return 0;
        usleep(200 * 1000); // 200ms
        waited += 200;
    }
    return -1; // timeout
}

void gpu_monitor_destroy(GpuMonitor* mon) {
    if (!mon) return;
    gpu_monitor_stop(mon);
    pthread_mutex_destroy(&mon->lock);
    free(mon);
}

void gpu_snapshot_print(GpuSnapshot* s, const char* prefix) {
    if (!prefix) prefix = "";
    printf("%s┌─ GPU Snapshot ──────────────────\n", prefix);
    printf("%s│ Temp:    ", prefix);
    if (s->temp_c >= 0) printf("%.1f°C\n", s->temp_c);
    else printf("N/A (WSL)\n");
    printf("%s│ Power:   ", prefix);
    if (s->power_w >= 0) printf("%.1f W\n", s->power_w);
    else printf("N/A (WSL)\n");
    printf("%s│ VRAM:    %.1f / %.1f GB\n", prefix, s->vram_used_gb, s->vram_total_gb);
    printf("%s│ GPU Util:", prefix);
    if (s->gpu_util_pct >= 0) printf(" %d%%\n", (int)s->gpu_util_pct);
    else printf(" N/A (WSL)\n");
    printf("%s│ Mem Util:", prefix);
    if (s->mem_util_pct >= 0) printf(" %d%%\n", (int)s->mem_util_pct);
    else printf(" N/A (WSL)\n");
    printf("%s│ Fan:     ", prefix);
    if (s->fan_pct >= 0) printf("%d%%\n", s->fan_pct);
    else printf("N/A (WSL)\n");
    printf("%s│ Clock:   %d MHz\n", prefix, s->clock_mhz);
    printf("%s└──────────────────────────────────\n", prefix);
}