import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const TRACEON_DIR = join(homedir(), '.traceon');
const DB_PATH = join(TRACEON_DIR, 'runs.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(TRACEON_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  return db;
}

export interface PersistRunInput {
  runId: string;
  traceId: string;
  status: string;
}

export function persistRun(run: PersistRunInput): void {
  const stmt = getDb().prepare(
    `INSERT INTO runs (run_id, trace_id, status, created_at) VALUES (?, ?, ?, ?)`,
  );
  stmt.run(run.runId, run.traceId, run.status, Date.now());
}
