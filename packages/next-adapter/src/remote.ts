import { z } from 'zod'
import type { InvocationDescriptor, TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { projectSchema, runSchema, taskDetailSchema, taskSchema, taskStatusSchema } from '@runwright/contracts'

const followFrameSchema = z.strictObject({
  kind: z.enum(['baseline', 'increment']),
  revision: z.number().int().nonnegative(),
  phase: z.enum(['ready', 'offline']),
  projects: z.array(projectSchema),
  tasks: z.array(taskSchema),
  details: z.record(z.string(), taskDetailSchema),
})

const codec = (typeSymbol: string, schema: z.ZodType): TypertCodec => ({
  mode: 'strict',
  typeSymbol,
  schema,
  create: () => schema,
} as unknown as TypertCodec)

const unary = (
  method: string,
  parameters: InvocationDescriptor['parameters'],
  result: TypertCodec,
): InvocationDescriptor => ({
  id: `@runwright/next-adapter:runwright/${method}`,
  service: 'runwright',
  namespace: 'runwright',
  method,
  invocation: { kind: 'direct' },
  parameters,
  cancellation: { parameter: 'signal' },
  result,
})

const parameter = (name: string, schema: z.ZodType): InvocationDescriptor['parameters'][number] => ({
  name,
  wire: name,
  source: 'json',
  codec: codec('RunwrightRemoteInput', schema),
})

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: '@runwright/next-adapter',
  descriptors: [
    unary('listProjects', [], codec('Project[]', z.array(projectSchema))),
    unary('registerProject', [parameter('input', z.strictObject({
      name: z.string().trim().min(1),
      rootPath: z.string().min(1),
    }))], codec('Project', projectSchema)),
    unary('createTask', [parameter('input', z.strictObject({
      projectId: z.string().min(1),
      prompt: z.string().trim().min(1),
    }))], codec('TaskDetail', taskDetailSchema)),
    unary('listTasks', [{
      ...parameter('filter', z.strictObject({
        projectId: z.string().min(1).optional(),
        status: taskStatusSchema.optional(),
      }).optional()),
      acceptsUndefined: true,
    }], codec('Task[]', z.array(taskSchema))),
    unary('getDetail', [parameter('taskId', z.string().min(1))], codec('TaskDetail', taskDetailSchema)),
    unary('cancelTask', [parameter('taskId', z.string().min(1))], codec('TaskDetail', taskDetailSchema)),
    unary('retryTask', [parameter('taskId', z.string().min(1))], codec('Run', runSchema)),
    unary('openSession', [parameter('taskId', z.string().min(1))], codec('string | undefined', z.string().min(1).optional())),
    {
      ...unary('follow', [], codec('RunwrightFollowFrame', followFrameSchema)),
      mode: 'stream',
    },
  ],
}

export default TYPERT_REMOTE
