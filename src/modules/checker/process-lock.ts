import fs from "node:fs";
import path from "node:path";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import { logger } from "../../shared/logger.js";

export interface LockPayload {
  pid: number;
  token: string;
  createdAt: number;
}

export interface LockAcquisitionResult {
  acquired: boolean;
  token?: string;
  reason?: string;
}

/**
 * Registry holding open Database connections for active locks held by this process.
 * Keyed by unique acquisition token.
 */
const activeLockConnections: Map<string, DatabaseInstance> = new Map();

/**
 * Checks if a process with the given PID is currently alive on POSIX/Linux.
 * Retained for backwards compatibility and diagnostic tooling.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

/**
 * Atomically acquires a cross-process execution lock using dedicated SQLite OS-level advisory locking (POSIX fcntl).
 *
 * Requirements & Guarantees:
 * - Uses a dedicated SQLite lock database file, completely separate from the product catalog database.
 * - Enforces fail-fast, non-blocking contention checking ({ timeout: 0 }).
 * - Issues BEGIN EXCLUSIVE to acquire an exclusive write lock on the database file in the Linux kernel.
 * - If another process or connection holds the lock, SQLite immediately throws SQLITE_BUSY, returned as acquired: false.
 * - The connection remains open and in an active exclusive transaction for the entire duration of the check.
 * - The lock file is NEVER unlinked or deleted from disk, eliminating check-then-unlink and stale-recovery races.
 * - When any process terminates (normal exit, SIGKILL, crash, or OOM), the Linux kernel automatically closes
 *   all open file descriptors, instantly releasing the POSIX fcntl advisory lock without requiring manual cleanup.
 */
export function acquireProcessLock(lockFilePath: string): LockAcquisitionResult {
  if (lockFilePath === ":memory:") {
    const token = `mem_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return { acquired: true, token };
  }

  const dir = path.dirname(lockFilePath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {}
  }

  const token = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  let lockDb: DatabaseInstance | null = null;
  try {
    lockDb = new Database(lockFilePath, { timeout: 0 });
    // Use TRUNCATE journal mode for this dedicated 1-page lock database to avoid lingering -wal / -shm files
    lockDb.pragma("journal_mode = TRUNCATE");
    lockDb.exec(
      "CREATE TABLE IF NOT EXISTS process_lock (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER, token TEXT, acquired_at TEXT);"
    );
    lockDb.exec("BEGIN EXCLUSIVE;");
    lockDb
      .prepare(
        "INSERT OR REPLACE INTO process_lock (id, pid, token, acquired_at) VALUES (1, ?, ?, ?);"
      )
      .run(process.pid, token, new Date().toISOString());

    activeLockConnections.set(token, lockDb);
    logger.debug(`Acquired OS execution lock (${lockFilePath}) with token ${token}`);
    return { acquired: true, token };
  } catch (error: any) {
    if (lockDb) {
      try {
        lockDb.close();
      } catch {}
    }

    if (error.code === "SQLITE_BUSY" || error.message?.includes("database is locked")) {
      return {
        acquired: false,
        reason: "Lock actively held by another process (SQLITE_BUSY)",
      };
    }

    logger.warn(`Unexpected error acquiring SQLite execution lock (${lockFilePath}): ${error.message}`);
    return { acquired: false, reason: error.message };
  }
}

/**
 * Releases the cross-process lock by rolling back/closing the dedicated database connection.
 * Closing the connection immediately releases the underlying OS fcntl advisory lock in the kernel.
 * Never unlinks or deletes the lockfile from disk.
 */
export function releaseProcessLock(lockFilePath: string, token: string): void {
  if (lockFilePath === ":memory:" || token.startsWith("mem_")) {
    return;
  }

  const lockDb = activeLockConnections.get(token);
  if (!lockDb) {
    logger.debug(`Lock token ${token} not found in active connections (already released or not owned)`);
    return;
  }

  try {
    try {
      lockDb.exec("ROLLBACK;");
    } catch {}
    lockDb.close();
    activeLockConnections.delete(token);
    logger.debug(`Released OS execution lock (${lockFilePath}) for token ${token}`);
  } catch (error: any) {
    logger.warn(`Error while releasing SQLite execution lock: ${error.message}`);
  }
}

/**
 * Test helper: forcibly closes all open lock connections in this process.
 */
export function _resetActiveLockConnectionsForTesting(): void {
  for (const [token, db] of activeLockConnections.entries()) {
    try {
      db.exec("ROLLBACK;");
    } catch {}
    try {
      db.close();
    } catch {}
    activeLockConnections.delete(token);
  }
}
