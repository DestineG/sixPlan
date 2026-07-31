import { buildApp } from './app.js';

const app = await buildApp();
try {
  await app.listen({ host: app.config.host, port: app.config.port });
  app.log.info(`sixPlan 已启动：http://${app.config.host}:${app.config.port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
