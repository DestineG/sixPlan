import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PasswordSchema, UsernameSchema, type UserDto, type UserRole } from '@sixplan/shared';
import { z } from 'zod';
import { AppError } from './errors.js';
import { createSessionToken, hashPassword, hashToken, normalizeUsername, verifyPassword } from './security.js';

const SESSION_COOKIE = 'sixplan_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  is_disabled: number;
  must_change_password: number;
  version: number;
  created_at: string;
  updated_at: string;
}

function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isDisabled: Boolean(row.is_disabled),
    mustChangePassword: Boolean(row.must_change_password),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createUser(
  app: FastifyInstance,
  username: string,
  password: string,
  role: UserRole = 'user',
  mustChangePassword = false
): Promise<UserDto> {
  const parsedUsername = UsernameSchema.parse(username);
  const parsedPassword = PasswordSchema.parse(password);
  const now = new Date().toISOString();
  const row: UserRow = {
    id: randomUUID(),
    username: parsedUsername,
    password_hash: await hashPassword(parsedPassword),
    role,
    is_disabled: 0,
    must_change_password: mustChangePassword ? 1 : 0,
    version: 1,
    created_at: now,
    updated_at: now
  };
  try {
    app.database.sqlite.prepare(`INSERT INTO users
      (id, username, username_normalized, password_hash, role, is_disabled, must_change_password, version, created_at, updated_at)
      VALUES (@id, @username, @username_normalized, @password_hash, @role, @is_disabled, @must_change_password, @version, @created_at, @updated_at)`)
      .run({ ...row, username_normalized: normalizeUsername(parsedUsername) });
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new AppError(409, 'USERNAME_EXISTS', '用户名已存在');
    throw error;
  }
  return toUserDto(row);
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.SIXPLAN_COOKIE_SECURE === 'true',
    maxAge: SESSION_MS / 1000
  });
}

async function issueSession(app: FastifyInstance, reply: FastifyReply, userId: string): Promise<void> {
  const { token, tokenHash } = createSessionToken();
  const now = new Date();
  app.database.sqlite.prepare(`INSERT INTO sessions
    (id, user_id, token_hash, expires_at, last_active_at, version, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .run(randomUUID(), userId, tokenHash, new Date(now.getTime() + SESSION_MS).toISOString(), now.toISOString(), now.toISOString());
  setSessionCookie(reply, token);
}

export async function requireAuth(request: FastifyRequest): Promise<void> {
  if (!request.currentUser) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
}

export async function requireReadyUser(request: FastifyRequest): Promise<void> {
  await requireAuth(request);
  if (request.currentUser?.mustChangePassword) {
    throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改临时密码');
  }
}

export async function requireAdmin(request: FastifyRequest): Promise<void> {
  await requireReadyUser(request);
  if (request.currentUser?.role !== 'admin') throw new AppError(403, 'FORBIDDEN', '需要管理员权限');
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(cookie);
  app.decorateRequest('currentUser', null);

  app.addHook('onRequest', async (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) {
        throw new AppError(403, 'INVALID_ORIGIN', '请求来源无效');
      }
    }

    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = app.database.sqlite.prepare(`SELECT s.id AS session_id, s.expires_at, u.*
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(hashToken(token)) as
      (UserRow & { session_id: string; expires_at: string }) | undefined;
    if (!session || session.is_disabled || Date.parse(session.expires_at) <= Date.now()) {
      if (session) app.database.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(session.session_id);
      return;
    }
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
    app.database.sqlite.prepare('UPDATE sessions SET last_active_at = ?, expires_at = ?, version = version + 1 WHERE id = ?')
      .run(now, expiresAt, session.session_id);
    request.currentUser = {
      id: session.id,
      username: session.username,
      role: session.role,
      mustChangePassword: Boolean(session.must_change_password),
      version: session.version
    };
  });

  app.get('/api/auth/registration', async () => {
    const setting = app.database.sqlite.prepare("SELECT value FROM system_settings WHERE key = 'registration_open'").get() as { value: string };
    return { open: setting.value === 'true' };
  });

  app.post('/api/auth/register', async (request, reply) => {
    const setting = app.database.sqlite.prepare("SELECT value FROM system_settings WHERE key = 'registration_open'").get() as { value: string };
    if (setting.value !== 'true') throw new AppError(403, 'REGISTRATION_CLOSED', '当前已关闭注册');
    const body = z.object({ username: UsernameSchema, password: PasswordSchema }).parse(request.body);
    const user = await createUser(app, body.username, body.password);
    await issueSession(app, reply, user.id);
    reply.code(201);
    return { user };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = z.object({ username: UsernameSchema, password: PasswordSchema }).parse(request.body);
    const row = app.database.sqlite.prepare('SELECT * FROM users WHERE username_normalized = ?')
      .get(normalizeUsername(body.username)) as UserRow | undefined;
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    }
    if (row.is_disabled) throw new AppError(403, 'ACCOUNT_DISABLED', '账号已被禁用');
    app.database.sqlite.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').run(row.id, new Date().toISOString());
    await issueSession(app, reply, row.id);
    return { user: toUserDto(row) };
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) app.database.sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { success: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => {
    const row = app.database.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(request.currentUser!.id) as UserRow;
    return { user: toUserDto(row) };
  });

  app.patch('/api/auth/password', { preHandler: requireAuth }, async (request, reply) => {
    const body = z.object({ currentPassword: z.string().optional(), newPassword: PasswordSchema }).parse(request.body);
    const row = app.database.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(request.currentUser!.id) as UserRow;
    if (!row.must_change_password) {
      if (!body.currentPassword || !(await verifyPassword(body.currentPassword, row.password_hash))) {
        throw new AppError(400, 'CURRENT_PASSWORD_INVALID', '当前密码错误');
      }
    }
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(body.newPassword);
    app.database.sqlite.transaction(() => {
      app.database.sqlite.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0,
        version = version + 1, updated_at = ? WHERE id = ?`).run(passwordHash, now, row.id);
      app.database.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    })();
    await issueSession(app, reply, row.id);
    return { success: true };
  });
}
