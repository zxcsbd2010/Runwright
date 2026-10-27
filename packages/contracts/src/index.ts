export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'attention'

export interface Project {
  id: string
  name: string
  rootPath: string
  createdAt: string
}

export interface Run {
  id: string
  taskId: string
  attempt: number
  runtimeId?: string
  sessionId?: string
  status: TaskStatus
  startedAt?: string
  endedAt?: string
  lastEventSeq?: number
  errorCode?: string
}

export interface Task {
  id: string
  projectId: string
  prompt: string
  status: TaskStatus
  activeRunId?: string
  createdAt: string
  updatedAt: string
}

export interface TaskDetail {
  task: Task
  runs: Run[]
  validationSummary?: string
}

export type ApprovalRequirement =
  | 'commit'
  | 'push'
  | 'deploy'
  | 'external_message'
  | 'outside_project'

export interface ExecutionPolicy {
  allowedTools: string[]
  requireApprovalFor: ApprovalRequirement[]
}

export interface RuntimeRunRef {
  runtimeId: string
  runId: string
  sessionId: string
}

export interface StartRunInput {
  runId: string
  project: Project
  prompt: string
  policy: ExecutionPolicy
}

export interface AttachRunInput {
  runId: string
  sessionId: string
  afterSeq?: number
}

export type RuntimeEvent =
  | { seq: number; type: 'run.started' }
  | { seq: number; type: 'run.progress'; summary: string }
  | { seq: number; type: 'approval.requested'; approvalId: string }
  | { seq: number; type: 'validation.completed'; summary: string }
  | { seq: number; type: 'run.succeeded'; summary: string }
  | { seq: number; type: 'run.failed'; errorCode: string }
  | { seq: number; type: 'run.attention'; reason: string }

export interface RunSnapshot {
  ref: RuntimeRunRef
  status: TaskStatus
  events: RuntimeEvent[]
}

export interface RuntimeDriver {
  startRun(input: StartRunInput): Promise<RuntimeRunRef>
  attachRun(input: AttachRunInput): Promise<RuntimeRunRef>
  cancelRun(ref: RuntimeRunRef): Promise<void>
  getRunSnapshot(ref: RuntimeRunRef): Promise<RunSnapshot>
  subscribe(ref: RuntimeRunRef): AsyncIterable<RuntimeEvent>
}

export interface RuntimeHello {
  protocolMajor: 1
  adapterVersion: string
  runtimeId: string
  runtimeKind: 'next'
  dshVersion: string
  nextVersion: string
  capabilities: string[]
}

export type CoreMethod =
  | 'projects.list'
  | 'projects.register'
  | 'tasks.create'
  | 'tasks.list'
  | 'tasks.detail'
  | 'tasks.cancel'
  | 'tasks.retry'
  | 'runtime.start'
  | 'runtime.attach'
  | 'runtime.cancel'
  | 'runtime.snapshot'

export interface CoreRequest {
  id: string
  method: CoreMethod
  params: unknown
}

export interface CoreError {
  code: string
  message: string
}

export type CoreResponse =
  | { id: string; result: unknown }
  | { id: string; error: CoreError }

export interface RuntimeHelloFrame {
  type: 'hello'
  hello: RuntimeHello
}

export interface RuntimeEventFrame {
  type: 'event'
  runtimeId: string
  runId: string
  event: RuntimeEvent
}

export type CoreFrame = CoreRequest | CoreResponse | RuntimeHelloFrame | RuntimeEventFrame

export * from './schemas.js'
