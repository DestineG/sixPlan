import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DisplaySettingsDto } from '@sixplan/shared';
import { requireReadyUser } from './auth.js';
import { AppError } from './errors.js';

interface DisplaySettingsRow {
  active_node_limit: number;
  version: number;
}

function getDisplaySettings(app: FastifyInstance, userId: string): DisplaySettingsDto {
  let row = app.database.sqlite.prepare(
    'SELECT active_node_limit, version FROM user_display_settings WHERE user_id = ?'
  ).get(userId) as DisplaySettingsRow | undefined;
  if (!row) {
    app.database.sqlite.prepare(
      'INSERT OR IGNORE INTO user_display_settings (user_id, active_node_limit, version, updated_at) VALUES (?, 5, 1, ?)'
    ).run(userId, new Date().toISOString());
    row = app.database.sqlite.prepare(
      'SELECT active_node_limit, version FROM user_display_settings WHERE user_id = ?'
    ).get(userId) as DisplaySettingsRow;
  }
  return { activeNodeLimit: row.active_node_limit, version: row.version };
}

export async function registerDisplaySettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireReadyUser);

  app.get('/api/display-settings', async (request) => ({
    settings: getDisplaySettings(app, request.currentUser!.id)
  }));

  app.put('/api/display-settings', async (request) => {
    const body = z.object({
      activeNodeLimit: z.number().int().min(1).max(10),
      expectedVersion: z.number().int().positive()
    }).parse(request.body);
    getDisplaySettings(app, request.currentUser!.id);
    const result = app.database.sqlite.prepare(`UPDATE user_display_settings
      SET active_node_limit = ?, version = version + 1, updated_at = ?
      WHERE user_id = ? AND version = ?`)
      .run(body.activeNodeLimit, new Date().toISOString(), request.currentUser!.id, body.expectedVersion);
    if (result.changes === 0) throw new AppError(409, 'VERSION_CONFLICT', '设置已被其他请求修改，请刷新后重试');
    return { settings: getDisplaySettings(app, request.currentUser!.id) };
  });
}
