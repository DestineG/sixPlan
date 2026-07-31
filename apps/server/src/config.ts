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
  isProduction: boolean;
}

export function loadConfig(): AppConfig {
  const dataDir = resolve(process.env.SIXPLAN_DATA_DIR ?? join(platformDataRoot(), 'sixplan'));
  const backupDir = join(dataDir, 'backups');
  const exportDir = join(dataDir, 'exports');
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(exportDir, { recursive: true });
  return {
    host: process.env.SIXPLAN_HOST ?? '127.0.0.1',
    port: Number(process.env.SIXPLAN_PORT ?? 4173),
    dataDir,
    databasePath: join(dataDir, 'sixplan.db'),
    backupDir,
    exportDir,
    isProduction: process.env.NODE_ENV === 'production'
  };
}
