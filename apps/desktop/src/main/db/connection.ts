/**
 * The local SQLite connection — one file per account (plus anonymous), in Electron's userData directory
 * (same trust boundary as any other file this app already writes there; no separate
 * encryption, matching how a browser's own local storage isn't encrypted either).
 *
 * Uses node:sqlite (DatabaseSync) rather than better-sqlite3: it ships inside
 * Node/Electron itself, so there is no native addon to compile or package with
 * electron-builder. Its synchronous API suits request/response-style IPC handlers.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { app } from 'electron';
import { runMigrations } from './migrate';
import { getCachedSession } from '../auth-cache';
import { databaseFileName } from './database-name';

let db: DatabaseSync | null = null;
let openPath: string | null = null;

function databasePath(): string {
  const accountId = getCachedSession()?.user_id;
  // The old local.db mixed anonymous and account state. Its ownership cannot be
  // reconstructed safely, so leave it untouched for recovery and start an isolated
  // anonymous cache rather than exposing possible account data after sign-out.
  return path.join(app.getPath('userData'), databaseFileName(accountId ?? null));
}

export function getDb(): DatabaseSync {
  const dbPath = databasePath();
  if (db && openPath === dbPath) {
    return db;
  }

  closeDb();
  db = new DatabaseSync(dbPath);
  openPath = dbPath;
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    runMigrations(db);
  } catch (error) {
    closeDb();
    throw error;
  }

  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
  openPath = null;
}
