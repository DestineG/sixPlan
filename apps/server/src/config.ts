import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

function platformDataRoot(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
}

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  backupDir: string;
  exportDir: string;
  importDir?: string;
  isProduction: boolean;
  cookieSecure?: boolean | 'auto';
  trustedProxy?: string;
  allowOpenDataDir?: boolean;
  importMaxFileBytes?: number;
  importMaxNodes?: number;
  importMaxEdges?: number;
  importMaxMarkdownBytes?: number;
  importMaxConcurrentPerUser?: number;
  importMaxConcurrentGlobal?: number;
  importTaskTimeoutMs?: number;
  importMaxTempBytes?: number;
  importSessionHours?: number;
}

function cookieSecureMode(value?: string): boolean | 'auto' {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return 'auto';
}

export function loadConfig(): AppConfig {
  const dataDir = resolve(process.env.SIXPLAN_DATA_DIR ?? join(platformDataRoot(), 'sixplan'));
  const backupDir = join(dataDir, 'backups');
  const exportDir = join(dataDir, 'exports');
  const importDir = join(dataDir, 'imports');
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(exportDir, { recursive: true });
  mkdirSync(importDir, { recursive: true });
  return {
    host: process.env.SIXPLAN_HOST ?? '127.0.0.1',
    port: Number(process.env.SIXPLAN_PORT ?? 4173),
    dataDir,
    databasePath: join(dataDir, 'sixplan.db'),
    backupDir,
    exportDir,
    importDir,
    isProduction: process.env.NODE_ENV === 'production',
    cookieSecure: cookieSecureMode(process.env.SIXPLAN_COOKIE_SECURE),
    ...(process.env.SIXPLAN_TRUST_PROXY ? { trustedProxy: process.env.SIXPLAN_TRUST_PROXY } : {}),
    allowOpenDataDir: process.env.SIXPLAN_ALLOW_OPEN_DATA_DIR !== 'false',
    importMaxFileBytes: Number(process.env.SIXPLAN_IMPORT_MAX_FILE_BYTES ?? 512 * 1024 * 1024),
    importMaxNodes: Number(process.env.SIXPLAN_IMPORT_MAX_NODES ?? 50_000),
    importMaxEdges: Number(process.env.SIXPLAN_IMPORT_MAX_EDGES ?? 250_000),
    importMaxMarkdownBytes: Number(process.env.SIXPLAN_IMPORT_MAX_MARKDOWN_BYTES ?? 5 * 1024 * 1024),
    importMaxConcurrentPerUser: Number(process.env.SIXPLAN_IMPORT_MAX_CONCURRENT_USER ?? 2),
    importMaxConcurrentGlobal: Number(process.env.SIXPLAN_IMPORT_MAX_CONCURRENT_GLOBAL ?? 8),
    importTaskTimeoutMs: Number(process.env.SIXPLAN_IMPORT_TASK_TIMEOUT_MS ?? 30 * 60 * 1000),
    importMaxTempBytes: Number(process.env.SIXPLAN_IMPORT_MAX_TEMP_BYTES ?? 2 * 1024 * 1024 * 1024),
    importSessionHours: Number(process.env.SIXPLAN_IMPORT_SESSION_HOURS ?? 24)
  };
}
