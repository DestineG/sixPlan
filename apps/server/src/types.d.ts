import type { UserRole } from '@sixplan/shared';
import type { AppConfig } from './config.js';
import type { DatabaseContext } from './db.js';

declare module 'fastify' {
  interface FastifyInstance {
    database: DatabaseContext;
    config: AppConfig;
  }
  interface FastifyRequest {
    currentUser: {
      id: string;
      username: string;
      role: UserRole;
      mustChangePassword: boolean;
      version: number;
    } | null;
  }
}
