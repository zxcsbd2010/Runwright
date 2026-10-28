import type { RuntimeEvent } from '@runwright/contracts'

export interface DshSessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

export function translateSessionEvent(event: DshSessionEvent, seq: number): RuntimeEvent[] {
  const data = record(event.data)
  switch (event.type) {
    case 'turn/start':
      return [{ seq, type: 'run.started' }]
    case 'assistant/message':
      return [{ seq, type: 'run.progress', summary: 'Assistant updated the session' }]
    case 'approval/asked':
      return typeof data.id === 'string' && data.id.length > 0
        ? [{ seq, type: 'approval.requested', approvalId: data.id }]
        : [{ seq, type: 'run.attention', reason: 'SESSION_EVENT_INVALID' }]
    case 'approval/decided':
      return typeof data.id === 'string' && data.id.length > 0
        ? [{ seq, type: 'approval.resolved', approvalId: data.id }]
        : [{ seq, type: 'run.attention', reason: 'SESSION_EVENT_INVALID' }]
    case 'tool/result': {
      const meta = record(data.meta)
      const validation = record(meta.runwrightValidation)
      return typeof validation.summary === 'string' && validation.summary.trim().length > 0
        ? [{ seq, type: 'validation.completed', summary: validation.summary }]
        : []
    }
    case 'turn/end':
      return translateTurnEnd(record(data.reason), seq)
    default:
      return []
  }
}

function translateTurnEnd(reason: Record<string, unknown>, seq: number): RuntimeEvent[] {
  switch (reason.kind) {
    case 'completed':
      return [{ seq, type: 'run.succeeded', summary: 'Run completed' }]
    case 'error': {
      const failure = record(reason.error)
      const code = typeof failure.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code)
        ? failure.code
        : 'AGENT_ERROR'
      return [{ seq, type: 'run.failed', errorCode: code }]
    }
    case 'aborted':
      return record(reason.reason).kind === 'user'
        ? [{ seq, type: 'run.cancelled' }]
        : [{ seq, type: 'run.attention', reason: 'CANCEL_UNKNOWN' }]
    case 'interrupted':
      return [{ seq, type: 'run.attention', reason: 'RUN_INTERRUPTED' }]
    case 'max-tokens':
      return [{ seq, type: 'run.attention', reason: 'MAX_TOKENS' }]
    case 'blocked':
      return [{ seq, type: 'run.attention', reason: 'RUN_BLOCKED' }]
    default:
      return [{ seq, type: 'run.attention', reason: 'TURN_END_UNKNOWN' }]
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}
