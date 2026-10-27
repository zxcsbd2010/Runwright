import { z } from 'zod'

const idSchema = z.string().min(1)
const summarySchema = z.string().min(1)
const eventBase = { seq: z.number().int().positive() }

export const taskStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'attention',
])

export const projectSchema = z.strictObject({
  id: idSchema,
  name: z.string().trim().min(1),
  rootPath: z.string().min(1),
  createdAt: z.iso.datetime(),
})

export const runSchema = z.strictObject({
  id: idSchema,
  taskId: idSchema,
  attempt: z.number().int().positive(),
  runtimeId: idSchema.optional(),
  sessionId: idSchema.optional(),
  status: taskStatusSchema,
  startedAt: z.iso.datetime().optional(),
  endedAt: z.iso.datetime().optional(),
  lastEventSeq: z.number().int().nonnegative().optional(),
  errorCode: z.string().min(1).optional(),
})

export const taskSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  prompt: z.string().trim().min(1),
  status: taskStatusSchema,
  activeRunId: idSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

export const taskDetailSchema = z.strictObject({
  task: taskSchema,
  runs: z.array(runSchema),
  validationSummary: z.string().optional(),
})

export const executionPolicySchema = z.strictObject({
  allowedTools: z.array(z.string().min(1)),
  requireApprovalFor: z.array(z.enum([
    'commit',
    'push',
    'deploy',
    'external_message',
    'outside_project',
  ])),
})

export const runtimeRunRefSchema = z.strictObject({
  runtimeId: idSchema,
  runId: idSchema,
  sessionId: idSchema,
})

export const startRunInputSchema = z.strictObject({
  runId: idSchema,
  project: projectSchema,
  prompt: z.string().trim().min(1),
  policy: executionPolicySchema,
})

export const attachRunInputSchema = z.strictObject({
  runId: idSchema,
  sessionId: idSchema,
  afterSeq: z.number().int().nonnegative().optional(),
})

export const runtimeEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...eventBase, type: z.literal('run.started') }),
  z.strictObject({ ...eventBase, type: z.literal('run.progress'), summary: summarySchema }),
  z.strictObject({ ...eventBase, type: z.literal('approval.requested'), approvalId: idSchema }),
  z.strictObject({ ...eventBase, type: z.literal('validation.completed'), summary: summarySchema }),
  z.strictObject({ ...eventBase, type: z.literal('run.succeeded'), summary: summarySchema }),
  z.strictObject({ ...eventBase, type: z.literal('run.failed'), errorCode: z.string().min(1) }),
  z.strictObject({ ...eventBase, type: z.literal('run.attention'), reason: summarySchema }),
])

export const runSnapshotSchema = z.strictObject({
  ref: runtimeRunRefSchema,
  status: taskStatusSchema,
  events: z.array(runtimeEventSchema),
})

export const runtimeHelloSchema = z.strictObject({
  protocolMajor: z.literal(1),
  adapterVersion: z.string().min(1),
  runtimeId: idSchema,
  runtimeKind: z.literal('next'),
  dshVersion: z.string().min(1),
  nextVersion: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
})

export const coreMethodSchema = z.enum([
  'projects.list',
  'projects.register',
  'tasks.create',
  'tasks.list',
  'tasks.detail',
  'tasks.cancel',
  'tasks.retry',
  'runtime.start',
  'runtime.attach',
  'runtime.cancel',
  'runtime.snapshot',
])

export const coreRequestSchema = z.strictObject({
  id: idSchema,
  method: coreMethodSchema,
  params: z.unknown(),
})

export const coreErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
})

export const coreResponseSchema = z.union([
  z.strictObject({ id: idSchema, result: z.unknown() }),
  z.strictObject({ id: idSchema, error: coreErrorSchema }),
])

export const runtimeHelloFrameSchema = z.strictObject({
  type: z.literal('hello'),
  hello: runtimeHelloSchema,
})

export const runtimeEventFrameSchema = z.strictObject({
  type: z.literal('event'),
  runtimeId: idSchema,
  runId: idSchema,
  event: runtimeEventSchema,
})

export const coreFrameSchema = z.union([
  coreRequestSchema,
  coreResponseSchema,
  runtimeHelloFrameSchema,
  runtimeEventFrameSchema,
])
