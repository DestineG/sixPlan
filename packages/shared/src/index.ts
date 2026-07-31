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
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NodeDto {
  id: string;
  planId: string;
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

export const PlanFileNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  status: NodeStatusSchema,
  startDate: DateOnlySchema,
  endDate: DateOnlySchema,
  summary: z.string().max(2000),
  extraContent: z.string(),
  positionX: z.number().finite(),
  positionY: z.number().finite(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const PlanFileEdgeSchema = z.object({
  id: z.string().min(1),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const PlanFileSchema = z.object({
  format: z.literal('sixplan-plan'),
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  areaName: z.string(),
  plan: z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(5000),
    status: PlanStatusSchema,
    archivedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  }),
  nodes: z.array(PlanFileNodeSchema),
  edges: z.array(PlanFileEdgeSchema)
});

export type PlanFile = z.infer<typeof PlanFileSchema>;

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
