// src/utils/db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import os from 'os';

let db;

export async function initializeDatabase(dbPath = null) {
  const resolvedPath = dbPath || path.join(process.cwd(), '.imlil', 'tasks.db');

  // Ensure directory exists
  const fs = await import('fs/promises');
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

  db = await open({
    filename: resolvedPath,
    driver: sqlite3.Database,
  });

  // Enable WAL mode for concurrent worker access
  await db.exec('PRAGMA journal_mode=WAL');
  await db.exec('PRAGMA busy_timeout=5000');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      status TEXT,
      dependencies TEXT,
      retries INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      purpose TEXT,
      type TEXT,
      status TEXT,
      createdAt TEXT,
      supervisorId TEXT
    );
  `);
}

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

/**
 * Open a read-only or shared connection to the same DB (for worker threads).
 * Workers should use this instead of calling initializeDatabase().
 */
export async function connectToDatabase(dbPath) {
  const dbConn = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });
  await dbConn.exec('PRAGMA journal_mode=WAL');
  await dbConn.exec('PRAGMA busy_timeout=5000');
  return dbConn;
}