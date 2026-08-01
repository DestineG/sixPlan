import { writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PasswordSchema, type UserDto, type UserRole } from '@sixplan/shared';
import { z } from 'zod';
import open from 'open';
import { requireAdmin } from './auth.js';
import { AppError } from './errors.js';
import { collectBackup, decodeBackup, encodeBackup, restoreSiteBackup } from './backup.js';
import { attachmentName } from './transfer-routes.js';
import { hashPassword } from './security.js';

interface UserRow {
  id: string; username: string; role: UserRole; is_disabled: number; must_change_password: number;
  version: number; created_at: string; updated_at: string;
}
function mapUser(row: UserRow): UserDto {
  return { id: row.id, username: row.username, role: row.role, isDisabled: Boolean(row.is_disabled),
    mustChangePassword: Boolean(row.must_change_password), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function isLoopback(address?: string): boolean {
  if (!address) return false;
  const value = address.replace(/^::ffff:/, '');
  return value === '127.0.0.1' || value === '::1' || (isIP(value) === 4 && value.startsWith('127.'));
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/api/admin/users', async () => {
    const rows = app.database.sqlite.prepare(`SELECT id,username,role,is_disabled,must_change_password,version,created_at,updated_at
      FROM users ORDER BY created_at`).all() as UserRow[];
    return { users: rows.map(mapUser) };
  });

  app.patch('/api/admin/users/:id/status', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ disabled: z.boolean(), expectedVersion: z.number().int().positive() }).parse(request.body);
    if (id === request.currentUser!.id && body.disabled) throw new AppError(409, 'CANNOT_DISABLE_SELF', '不能禁用当前管理员账号');
    const result = app.database.sqlite.prepare(`UPDATE users SET is_disabled = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?`).run(body.disabled ? 1 : 0, new Date().toISOString(), id, body.expectedVersion);
    if (result.changes === 0) throw new AppError(409, 'VERSION_CONFLICT', '账号已被其他操作更新');
    if (body.disabled) app.database.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return { success: true };
  });

  app.post('/api/admin/users/:id/reset-password', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ password: PasswordSchema, expectedVersion: z.number().int().positive() }).parse(request.body);
    const passwordHash = await hashPassword(body.password);
    const result = app.database.sqlite.transaction(() => {
      const updated = app.database.sqlite.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1,
        version = version + 1, updated_at = ? WHERE id = ? AND version = ?`)
        .run(passwordHash, new Date().toISOString(), id, body.expectedVersion);
      if (updated.changes > 0) app.database.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      return updated;
    })();
    if (result.changes === 0) throw new AppError(409, 'VERSION_CONFLICT', '账号已被其他操作更新');
    return { success: true };
  });

  app.get('/api/admin/settings', async () => {
    const row = app.database.sqlite.prepare("SELECT value,version FROM system_settings WHERE key='registration_open'").get() as { value: string; version: number };
    return { registrationOpen: row.value === 'true', version: row.version };
  });

  app.patch('/api/admin/settings/registration', async (request) => {
    const body = z.object({ open: z.boolean(), expectedVersion: z.number().int().positive() }).parse(request.body);
    const result = app.database.sqlite.prepare(`UPDATE system_settings SET value=?, version=version+1, updated_at=? WHERE key='registration_open' AND version=?`)
      .run(body.open ? 'true' : 'false', new Date().toISOString(), body.expectedVersion);
    if (result.changes === 0) throw new AppError(409, 'VERSION_CONFLICT', '设置已被其他操作更新');
    return { success: true };
  });

  app.get('/api/admin/storage', async () => ({ dataDir: app.config.dataDir, databasePath: app.config.databasePath,
    backupDir: app.config.backupDir, exportDir: app.config.exportDir }));

  app.post('/api/admin/storage/open', async (request) => {
    if (app.config.allowOpenDataDir === false) throw new AppError(403, 'STORAGE_OPEN_DISABLED', '当前部署方式不允许打开数据目录');
    if (!isLoopback(request.ip)) throw new AppError(403, 'LOOPBACK_REQUIRED', '只有从服务主机本机访问时才能打开目录');
    await open(app.config.dataDir);
    return { success: true };
  });

  app.post('/api/admin/backups/export', async (request, reply) => {
    const body = z.object({ password: z.string().min(8).max(128).optional() }).parse(request.body ?? {});
    const buffer = await encodeBackup(collectBackup(app, 'site'), body.password);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${attachmentName('sixplan-site')}"`);
    return buffer;
  });

  app.post('/api/admin/backups/restore', async (request) => {
    const part = await request.file({ limits: { fileSize: 1024 * 1024 * 1024, files: 1 } });
    if (!part) throw new AppError(400, 'BACKUP_FILE_REQUIRED', '请选择备份文件');
    const passwordField = part.fields.password as { value?: unknown } | undefined;
    const password = typeof passwordField?.value === 'string' ? passwordField.value : undefined;
    const payload = await decodeBackup(await part.toBuffer(), password || undefined);
    const before = await encodeBackup(collectBackup(app, 'site'));
    await writeFile(join(app.config.backupDir, attachmentName('before-site-restore')), before);
    restoreSiteBackup(app, payload);
    return { success: true };
  });
}
