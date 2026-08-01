import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  usernameNormalized: text('username_normalized').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  isDisabled: integer('is_disabled', { mode: 'boolean' }).notNull().default(false),
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  lastActiveAt: text('last_active_at').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull()
});

export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: text('updated_at').notNull()
});

export const areas = sqliteTable('areas', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  nameNormalized: text('name_normalized').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [uniqueIndex('areas_user_name_unique').on(table.userId, table.nameNormalized)]);

export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  areaId: text('area_id').notNull().references(() => areas.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  status: text('status', { enum: ['planning', 'active', 'completed', 'paused'] }).notNull().default('planning'),
  archivedAt: text('archived_at'),
  version: integer('version').notNull().default(1),
  graphRevision: integer('graph_revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  planId: text('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
  key: text('node_key').notNull(),
  title: text('title').notNull(),
  status: text('status', { enum: ['not_started', 'in_progress', 'completed', 'paused', 'abandoned'] }).notNull().default('not_started'),
  startDate: text('start_date'),
  endDate: text('end_date'),
  summary: text('summary').notNull().default(''),
  extraContent: text('extra_content').notNull().default(''),
  positionX: real('position_x').notNull().default(0),
  positionY: real('position_y').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [uniqueIndex('nodes_plan_key_unique').on(table.planId, table.key)]);

export const edges = sqliteTable('edges', {
  id: text('id').primaryKey(),
  planId: text('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
  sourceNodeId: text('source_node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  targetNodeId: text('target_node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
}, (table) => [uniqueIndex('edges_direction_unique').on(table.planId, table.sourceNodeId, table.targetNodeId)]);

export const userImportSettings = sqliteTable('user_import_settings', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  maxNodes: integer('max_nodes').notNull().default(0),
  maxEdges: integer('max_edges').notNull().default(0),
  maxMarkdownBytes: integer('max_markdown_bytes').notNull().default(0),
  maxFileBytes: integer('max_file_bytes').notNull().default(0),
  sessionHours: integer('session_hours').notNull().default(24),
  version: integer('version').notNull().default(1),
  updatedAt: text('updated_at').notNull()
});

export const importSessions = sqliteTable('import_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['snapshot', 'changeset'] }).notNull(),
  filePath: text('file_path').notNull(),
  status: text('status', { enum: ['ready', 'applied'] }).notNull().default('ready'),
  targetPlanId: text('target_plan_id').references(() => plans.id, { onDelete: 'cascade' }),
  sourceName: text('source_name').notNull().default('pasted.json'),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull()
});
