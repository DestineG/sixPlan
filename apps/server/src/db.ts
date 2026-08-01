import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { AppConfig } from './config.js';
import * as schema from './schema.js';

const migrations = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL, username_normalized TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', is_disabled INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, last_active_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS areas (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, name_normalized TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(user_id, name_normalized)
  );
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY, area_id TEXT NOT NULL REFERENCES areas(id) ON DELETE RESTRICT,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planning',
    archived_at TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'not_started', start_date TEXT, end_date TEXT,
    summary TEXT NOT NULL DEFAULT '', extra_content TEXT NOT NULL DEFAULT '',
    position_x REAL NOT NULL DEFAULT 0, position_y REAL NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(plan_id, source_node_id, target_node_id)
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS areas_user_idx ON areas(user_id);
  CREATE INDEX IF NOT EXISTS plans_area_idx ON plans(area_id);
  CREATE INDEX IF NOT EXISTS nodes_plan_idx ON nodes(plan_id);
  CREATE INDEX IF NOT EXISTS edges_plan_idx ON edges(plan_id);`,
  `ALTER TABLE plans ADD COLUMN graph_revision INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE nodes ADD COLUMN node_key TEXT;
  UPDATE nodes SET node_key = 'node-' || lower(substr(replace(id, '-', ''), 1, 12)) WHERE node_key IS NULL;
  CREATE UNIQUE INDEX nodes_plan_key_unique ON nodes(plan_id, node_key);
  CREATE TABLE user_import_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    max_nodes INTEGER NOT NULL DEFAULT 0, max_edges INTEGER NOT NULL DEFAULT 0,
    max_markdown_bytes INTEGER NOT NULL DEFAULT 0, max_file_bytes INTEGER NOT NULL DEFAULT 0,
    session_hours INTEGER NOT NULL DEFAULT 24, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
  );
  CREATE TABLE import_sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, file_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX import_sessions_user_idx ON import_sessions(user_id);
  CREATE INDEX import_sessions_expiry_idx ON import_sessions(expires_at);`,
  `ALTER TABLE import_sessions ADD COLUMN target_plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE;
  ALTER TABLE import_sessions ADD COLUMN source_name TEXT NOT NULL DEFAULT 'pasted.json';`,
  `CREATE TRIGGER IF NOT EXISTS nodes_node_key_required_insert BEFORE INSERT ON nodes WHEN NEW.node_key IS NULL
    BEGIN SELECT RAISE(ABORT, 'node_key required'); END;
  CREATE TRIGGER IF NOT EXISTS nodes_node_key_required_update BEFORE UPDATE OF node_key ON nodes WHEN NEW.node_key IS NULL
    BEGIN SELECT RAISE(ABORT, 'node_key required'); END;`,
  `ALTER TABLE plans ADD COLUMN plan_key TEXT;
  UPDATE plans SET plan_key = 'plan-' || lower(substr(replace(id, '-', ''), 1, 12)) WHERE plan_key IS NULL;
  CREATE UNIQUE INDEX plans_plan_key_unique ON plans(plan_key);
  CREATE TRIGGER IF NOT EXISTS plans_plan_key_required_insert BEFORE INSERT ON plans WHEN NEW.plan_key IS NULL
    BEGIN SELECT RAISE(ABORT, 'plan_key required'); END;
  CREATE TRIGGER IF NOT EXISTS plans_plan_key_required_update BEFORE UPDATE OF plan_key ON plans WHEN NEW.plan_key IS NULL
    BEGIN SELECT RAISE(ABORT, 'plan_key required'); END;
  CREATE TABLE plan_links (
    id TEXT PRIMARY KEY,
    parent_node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
    child_plan_id TEXT NOT NULL UNIQUE REFERENCES plans(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX plan_links_child_idx ON plan_links(child_plan_id);`
];

export interface DatabaseContext {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
}

export function createDatabase(config: AppConfig): DatabaseContext {
  const sqlite = new Database(config.databasePath);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (sqlite.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((row) => row.version)
  );
  migrations.forEach((migration, index) => {
    const version = index + 1;
    if (applied.has(version)) return;
    sqlite.transaction(() => {
      sqlite.exec(migration);
      sqlite.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    })();
  });
  sqlite.prepare(`INSERT OR IGNORE INTO system_settings(key, value, version, updated_at) VALUES ('registration_open', 'true', 1, ?)`)
    .run(new Date().toISOString());
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
