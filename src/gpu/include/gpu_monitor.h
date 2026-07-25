/*
 * gpu_monitor.h — GPU Safety Monitor Daemon
 * 
 * Watches temperature, power, and VRAM in real-time.
 * Auto-throttles agent launches if limits are breached.
 * 
 * RTX 3070 Ti Safe Limits:
 *   - Temperature: 80°C throttle, 83°C emergency stop
 *   - Power: 250W throttle, 290W emergency stop
 *   - VRAM: 7.0 GB throttle, 8.0 GB emergency stop
 */

#ifndef GPU_MONITOR_H
#define GPU_MONITOR_H

#include <cuda_runtime.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <unistd.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ——— Config ——— */
typedef struct {
    double temp_throttle_c;      // 80.0
    double temp_emergency_c;     // 83.0
    double power_throttle_w;     // 250.0
    double power_emergency_w;    // 290.0
    double vram_throttle_gb;     // 7.0
    double vram_emergency_gb;    // 8.0
    int    poll_interval_ms;     // 500
} GpuMonitorConfig;

#define GPU_MONITOR_DEFAULT_CONFIG { \
    .temp_throttle_c = 80.0,        \
    .temp_emergency_c = 83.0,       \
    .power_throttle_w = 250.0,      \
    .power_emergency_w = 290.0,     \
    .vram_throttle_gb = 7.0,        \
    .vram_emergency_gb = 8.0,       \
    .poll_interval_ms = 500         \
}

/* ——— State ——— */
typedef enum {
    GPU_SAFE = 0,
    GPU_THROTTLED,       // Reduce agent count
    GPU_EMERGENCY_STOP,  // Kill all running agents
} GpuSafetyLevel;

typedef struct {
    double temp_c;
    double power_w;
    double vram_used_gb;
    double vram_total_gb;
    double gpu_util_pct;
    double mem_util_pct;
    int    fan_pct;
    int    clock_mhz;
} GpuSnapshot;

typedef struct {
    GpuMonitorConfig config;
    pthread_t        thread;
    volatile int     running;
    volatile GpuSafetyLevel safety;
    volatile GpuSnapshot    last_snapshot;
    pthread_mutex_t  lock;
    int              device_index;
} GpuMonitor;

/* ——— API ——— */

/* Initialize and start monitor thread */
GpuMonitor* gpu_monitor_create(int device_index);
GpuMonitor* gpu_monitor_create_with_config(GpuMonitorConfig config, int device_index);

/* Start/stop the polling thread */
int gpu_monitor_start(GpuMonitor* mon);
int gpu_monitor_stop(GpuMonitor* mon);

/* Get current safety level (thread-safe) */
GpuSafetyLevel gpu_monitor_get_safety(GpuMonitor* mon);

/* Get latest snapshot (thread-safe) */
GpuSnapshot gpu_monitor_get_snapshot(GpuMonitor* mon);

/* Block until safety level is SAFE (for throttle recovery) */
int gpu_monitor_wait_until_safe(GpuMonitor* mon, int timeout_ms);

/* Destroy monitor */
void gpu_monitor_destroy(GpuMonitor* mon);

/* ——— Utility ——— */

/* Pretty-print a snapshot */
void gpu_snapshot_print(GpuSnapshot* s, const char* prefix);

/* Check if a snapshot is within safe limits */
GpuSafetyLevel gpu_check_limits(GpuSnapshot* s, GpuMonitorConfig* config);

#ifdef __cplusplus
}
#endif

#endif /* GPU_MONITOR_H */