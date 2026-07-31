import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { loadConfig, type AppConfig } from './config.js';
import { createDatabase } from './db.js';
import { AppError } from './errors.js';
import { registerAuth } from './auth.js';
import { registerDomainRoutes } from './domain-routes.js';
import { registerTransferRoutes } from './transfer-routes.js';
import { registerAdminRoutes } from './admin-routes.js';

export async function buildApp(config: AppConfig = loadConfig()): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy: false, bodyLimit: 30 * 1024 * 1024 });
  app.decorate('config', config);
  app.decorate('database', createDatabase(config));
  await app.register(multipart);
  await registerAuth(app);

  app.get('/api/health', async () => ({ status: 'ok', version: '0.1.0' }));
  await app.register(registerDomainRoutes);
  await app.register(registerTransferRoutes);
  await app.register(registerAdminRoutes);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message, details: error.details });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({ code: 'VALIDATION_ERROR', message: '请求数据无效', details: error.flatten() });
    }
    app.log.error(error);
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  });

  const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (config.isProduction && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在' });
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    app.database.sqlite.close();
  });
  return app;
}
