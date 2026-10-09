import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type DB = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  sqlite: Database.Database;
  db: DB;
}

export function openDatabase(dbPath: string): OpenedDatabase {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle({ client: sqlite, schema });
  // Папка drizzle/ лежит в корне проекта (в Docker-образе — /app/drizzle)
  migrate(db, { migrationsFolder: path.resolve('drizzle') });

  return { sqlite, db };
}
