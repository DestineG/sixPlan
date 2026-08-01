import { z } from 'zod';

export const PLAN_STATUSES = ['planning', 'active', 'completed', 'paused'] as const;
export const NODE_STATUSES = ['not_started', 'in_progress', 'completed', 'paused', 'abandoned'] as const;
export const USER_ROLES = ['user', 'admin'] as const;

export const PlanStatusSchema = z.enum(PLAN_STATUSES);
export const NodeStatusSchema = z.enum(NODE_STATUSES);
export const UserRoleSchema = z.enum(USER_ROLES);
export const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
export const UsernameSchema = z.string().min(3).max(32).regex(/^[A-Za-z0-9._-]+$/);
export const PasswordSchema = z.string().min(8).max(128);

export type PlanStatus = z.infer<typeof PlanStatusSchema>;
export type NodeStatus = z.infer<typeof NodeStatusSchema>;
export type UserRole = z.infer<typeof UserRoleSchema>;

export function deriveDateManagedNodeStatus(status: NodeStatus, startDate: string | null, today: string): NodeStatus {
  if (status !== 'not_started' && status !== 'in_progress') return status;
  return startDate && startDate <= today ? 'in_progress' : 'not_started';
}

export function isNodeOverdue(status: NodeStatus, endDate: string | null, today: string): boolean {
  return status === 'in_progress' && Boolean(endDate && endDate < today);
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface UserDto {
  id: string;
  username: string;
  role: UserRole;
  isDisabled: boolean;
  mustChangePassword: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AreaDto {
  id: string;
  name: string;
  sortOrder: number;
  version: number;
  planCount: number;
  activePlanCount: number;
  archivedPlanCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanDto {
  id: string;
  areaId: string;
  areaName: string;
  name: string;
  description: string;
  status: PlanStatus;
  archivedAt: string | null;
  version: number;
  graphRevision: number;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NodeDto {
  id: string;
  planId: string;
  key: string;
  title: string;
  status: NodeStatus;
  startDate: string | null;
  endDate: string | null;
  summary: string;
  extraContent: string;
  positionX: number;
  positionY: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EdgeDto {
  id: string;
  planId: string;
  sourceNodeId: string;
  targetNodeId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface GraphDto {
  plan: PlanDto;
  nodes: NodeDto[];
  edges: EdgeDto[];
}

export const NodeKeySchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/);
export const IsoTimestampSchema = z.string().datetime();

export const PlanSnapshotNodeSchema = z.object({
  key: NodeKeySchema,
  title: z.string().trim().min(1).max(200),
  status: NodeStatusSchema.default('not_started'),
  startDate: DateOnlySchema.optional().default(null),
  endDate: DateOnlySchema.optional().default(null),
  summary: z.string().max(2000).optional().default(''),
  markdown: z.string().optional().default(''),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
  createdAt: IsoTimestampSchema.optional(),
  updatedAt: IsoTimestampSchema.optional()
}).strict();

export const PlanSnapshotEdgeSchema = z.object({
  source: NodeKeySchema,
  target: NodeKeySchema,
  createdAt: IsoTimestampSchema.optional(),
  updatedAt: IsoTimestampSchema.optional()
}).strict();

export const PlanSnapshotPayloadSchema = z.object({
  plan: z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(5000).optional().default(''),
    status: PlanStatusSchema.optional().default('planning'),
    archivedAt: IsoTimestampSchema.nullable().optional().default(null),
    createdAt: IsoTimestampSchema.optional(),
    updatedAt: IsoTimestampSchema.optional()
  }).strict(),
  nodes: z.array(PlanSnapshotNodeSchema),
  edges: z.array(PlanSnapshotEdgeSchema).optional().default([])
}).strict();

export const PlanSnapshotSchema = PlanSnapshotPayloadSchema.extend({
  format: z.literal('sixplan-plan-snapshot'),
  version: z.literal(2),
  exportedAt: IsoTimestampSchema.optional(),
  areaName: z.string().trim().min(1).max(100).optional()
}).strict();

const NodeChangesSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  status: NodeStatusSchema.optional(),
  startDate: DateOnlySchema.optional(),
  endDate: DateOnlySchema.optional(),
  summary: z.string().max(2000).optional(),
  markdown: z.string().optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'changes 至少包含一个字段');

const PlanChangesSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  status: PlanStatusSchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'planChanges 至少包含一个字段');

export const PlanChangeSetSchema = z.object({
  format: z.literal('sixplan-plan-changeset'),
  version: z.literal(2),
  targetPlanName: z.string().trim().min(1).max(200).optional(),
  baseRevision: z.number().int().positive(),
  planChanges: PlanChangesSchema.optional(),
  operations: z.object({
    addNodes: z.array(PlanSnapshotNodeSchema).optional().default([]),
    updateNodes: z.array(z.object({ key: NodeKeySchema, changes: NodeChangesSchema }).strict()).optional().default([]),
    removeNodes: z.array(NodeKeySchema).optional().default([]),
    addEdges: z.array(PlanSnapshotEdgeSchema.omit({ createdAt: true, updatedAt: true }).strict()).optional().default([]),
    removeEdges: z.array(PlanSnapshotEdgeSchema.omit({ createdAt: true, updatedAt: true }).strict()).optional().default([])
  }).strict()
}).strict();

export const AreaFileSchema = z.object({
  format: z.literal('sixplan-area'),
  version: z.literal(2),
  exportedAt: IsoTimestampSchema,
  area: z.object({ name: z.string().trim().min(1).max(100), createdAt: IsoTimestampSchema, updatedAt: IsoTimestampSchema }).strict(),
  plans: z.array(PlanSnapshotPayloadSchema)
}).strict();

export type PlanSnapshotNode = z.infer<typeof PlanSnapshotNodeSchema>;
export type PlanSnapshotEdge = z.infer<typeof PlanSnapshotEdgeSchema>;
export type PlanSnapshotPayload = z.infer<typeof PlanSnapshotPayloadSchema>;
export type PlanSnapshot = z.infer<typeof PlanSnapshotSchema>;
export type PlanChangeSet = z.infer<typeof PlanChangeSetSchema>;
export type AreaFile = z.infer<typeof AreaFileSchema>;

export interface ImportSettingsDto {
  maxNodes: number;
  maxEdges: number;
  maxMarkdownBytes: number;
  maxFileBytes: number;
  sessionHours: number;
  version: number;
}

export interface ImportPreviewDto {
  sessionId: string;
  kind: 'snapshot' | 'changeset';
  planName: string;
  suggestedAreaName?: string;
  baseRevision?: number;
  currentRevision?: number;
  revisionChanged?: boolean;
  nodeCount: number;
  edgeCount: number;
  addNodeCount: number;
  updateNodeCount: number;
  removeNodeCount: number;
  addEdgeCount: number;
  removeEdgeCount: number;
  needsLayout: boolean;
  expiresAt: string;
  previewNodes: Array<{ key: string; title: string; status: NodeStatus; change: 'existing' | 'add' | 'update' | 'remove' }>;
  previewEdges: Array<{ source: string; target: string; change: 'existing' | 'add' | 'remove' }>;
}

export interface ImportDecision {
  fileName: string;
  targetAreaId?: string;
  createAreaName?: string;
}

export interface ImportResult {
  fileName: string;
  success: boolean;
  plan?: PlanDto;
  code?: string;
  message?: string;
}

export const planStatusLabels: Record<PlanStatus, string> = {
  planning: '规划中',
  active: '进行中',
  completed: '已完成',
  paused: '暂停'
};

export const nodeStatusLabels: Record<NodeStatus, string> = {
  not_started: '未开始',
  in_progress: '进行中',
  completed: '已完成',
  paused: '暂停',
  abandoned: '放弃'
};
