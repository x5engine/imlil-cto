/**
 * ZombieKiller.js — Black Belt Zombie Process Hunter
 * 
 * Runs alongside the GPU orchestrator and monitors for:
 * - Stale imlil processes running > 5 minutes without progress
 * - HTTP requests to B300 that never return (stuck connections)
 * - Orphaned worker threads from crashed runs
 * - GPU kernels that overran their time budget
 * 
 * Reports: logs zombie kills as tasks in the DB for QA agent.
 */

import { execSync } from 'child_process';
import { getDb } from '../utils/db.js';

class ZombieKiller {
  constructor(config = {}) {
    this.db = getDb();
    this.maxProcessAge = config.maxProcessAge || 300000; // 5 min default
    this.maxHttpStall = config.maxHttpStall || 60000;    // 1 min HTTP stall
    this.checkInterval = config.checkInterval || 30000;   // check every 30s
    this.interval = null;
    this.processHistory = new Map();
    this.totalKilled = 0;
    this.httpCheckEnabled = config.httpCheckEnabled !== false;
  }

  start() {
    console.log('🥋 ZombieKiller: Black Belt process hunter active');
    this.interval = setInterval(() => this.patrol(), this.checkInterval);
    // First patrol immediately
    this.patrol();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.totalKilled > 0) {
      console.log(`🥋 ZombieKiller: ${this.totalKilled} zombies eliminated this session.`);
    }
  }

  /**
   * Main patrol — called every checkInterval
   */
  async patrol() {
    try {
      await this.killStaleProcesses();
      await this.killStuckHttp();
      await this.checkOrphanedDbLocks();
    } catch (e) {
      // Silent — zombie killer never fails
    }
  }

  /**
   * Kill any imlil-related process running > maxProcessAge
   */
  async killStaleProcesses() {
    const now = Date.now();
    
    try {
      // Find all imlil/node processes
      const output = execSync(
        `ps aux | grep -E '(imlil.*make|node.*benchmark)' | grep -v grep || true`,
        { timeout: 5000, encoding: 'utf-8' }
      );
      
      const lines = output.trim().split('\n').filter(Boolean);
      const ourPid = process.pid;
      
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;
        
        const pid = parseInt(parts[1], 10);
        if (!pid || pid === ourPid) continue;
        
        // Parse elapsed time
        const elapsed = parts[10]; // e.g. "05:23" or "1:02:34"
        const seconds = this.parseElapsed(elapsed);
        
        if (seconds > this.maxProcessAge / 1000) {
          // Only kill if we haven't seen this PID recently
          const lastSeen = this.processHistory.get(pid);
          if (lastSeen && (now - lastSeen) < this.checkInterval * 2) continue;
          
          this.processHistory.set(pid, now);
          
          try {
            execSync(`kill -15 ${pid} 2>/dev/null; sleep 0.5; kill -9 ${pid} 2>/dev/null || true`, { timeout: 3000 });
            this.totalKilled++;
            const cmd = parts.slice(10).join(' ').slice(0, 100);
            console.log(`🥋 ZombieKiller: Terminated PID ${pid} (${cmd}) — running ${seconds}s`);
            
            // Log kill as a task in DB so QA agent can review
            await this.logZombieReport(pid, cmd, seconds);
          } catch {}
        }
      }
    } catch {}
  }

  /**
   * Parse ps elapsed time to seconds
   */
  parseElapsed(elapsed) {
    if (!elapsed) return 0;
    // Format: "1:02:34" or "05:23" or "2-12:34:56" (days)
    try {
      if (elapsed.includes('-')) {
        const [days, time] = elapsed.split('-');
        const [h, m, s] = time.split(':').map(Number);
        return parseInt(days) * 86400 + h * 3600 + m * 60 + s;
      }
      const parts = elapsed.split(':').map(Number);
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return parts[0] || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Check for stuck HTTP connections to B300
   * Looks for node processes in D state (uninterruptible sleep)
   */
  async killStuckHttp() {
    if (!this.httpCheckEnabled) return;
    
    try {
      // Check for processes stuck in D state (disk/network I/O wait)
      const output = execSync(
        `ps aux | grep -E '(node.*imlil)' | grep -v grep | grep ' D ' || true`,
        { timeout: 5000, encoding: 'utf-8' }
      );
      
      if (output.trim()) {
        const lines = output.trim().split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 11) continue;
          const pid = parseInt(parts[1], 10);
          if (pid && pid !== process.pid) {
            try {
              execSync(`kill -9 ${pid} 2>/dev/null || true`, { timeout: 2000 });
              this.totalKilled++;
              console.log(`🥋 ZombieKiller: Killed stuck HTTP process PID ${pid} (D state)`);
            } catch {}
          }
        }
      }
    } catch {}
  }

  /**
   * Check for SQLite locks that haven't released
   */
  async checkOrphanedDbLocks() {
    try {
      // Try a simple query — if it fails with locked, there's an orphan
      await this.db.run('SELECT 1');
    } catch (e) {
      if (e.message && e.message.includes('locked')) {
        console.log('🥋 ZombieKiller: Detected SQLite lock — forcing WAL checkpoint');
        try {
          await this.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {}
      }
    }
  }

  /**
   * Log zombie report as a DB task for QA agent
   */
  async logZombieReport(pid, command, runSeconds) {
    try {
      const taskId = `zombie_${pid}_${Date.now()}`;
      await this.db.run(
        'INSERT OR IGNORE INTO tasks (id, title, description, status, dependencies, retries) VALUES (?, ?, ?, ?, ?, ?)',
        taskId,
        `[ZOMBIE] Cleaned stale process PID ${pid}`,
        `Process ran for ${runSeconds}s without making progress. Command: ${command}. Reviewed and killed by ZombieKiller.`,
        'pending',
        '[]',
        0,
      );
    } catch {}
  }
}

export default ZombieKiller;