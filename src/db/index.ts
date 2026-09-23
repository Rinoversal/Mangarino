import { openDatabaseSync, SQLiteDatabase } from 'expo-sqlite';

import { SCHEMA_V1, SCHEMA_VERSION } from './schema';

let db: SQLiteDatabase | null = null;
let ready: Promise<SQLiteDatabase> | null = null;

/** Module-level singleton so stores and loaders can use the DB outside React. */
export function getDb(): SQLiteDatabase {
  if (!db) db = openDatabaseSync('mangarino.db');
  return db;
}

export function initDb(): Promise<SQLiteDatabase> {
  if (!ready) {
    ready = (async () => {
      const d = getDb();
      await d.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      const row = await d.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      const current = row?.user_version ?? 0;
      if (current < 1) {
        await d.execAsync(SCHEMA_V1);
      }
      if (current < SCHEMA_VERSION) {
        await d.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
      return d;
    })();
  }
  return ready;
}
