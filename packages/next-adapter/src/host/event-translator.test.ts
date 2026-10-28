import { describe, expect, it } from 'vitest'
import { translateSessionEvent } from './event-translator.js'
import type { DshSessionEvent } from './event-translator.js'

function event(type: string, data: unknown, seq = 0): DshSessionEvent {
  return { type, data, seq, time: 1_792_000_000_000 }
}

describe('DSH event translation', () => {
  it('maps lifecycle and approval events without copying Session content', () => {
    expect(translateSessionEvent(event('turn/start', { turn: 1 }), 1)).toEqual([
      { seq: 1, type: 'run.started' },
    ])
    expect(translateSessionEvent(event('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'message-1',
        role: 'assistant',
        source: { kind: 'model' },
        content: [{ type: 'text', text: 'secret assistant output' }],
      },
    }), 2)).toEqual([{ seq: 2, type: 'run.progress', summary: 'Assistant updated the session' }])
    expect(translateSessionEvent(event('approval/asked', {
      id: 'approval-1',
      toolName: 'shell',
      callId: 'call-1',
      reason: 'secret approval detail',
    }), 3)).toEqual([{ seq: 3, type: 'approval.requested', approvalId: 'approval-1' }])
    expect(translateSessionEvent(event('approval/decided', {
      id: 'approval-1',
      outcome: 'allowed-once',
    }), 4)).toEqual([{ seq: 4, type: 'approval.resolved', approvalId: 'approval-1' }])
  })

  it('accepts only structured validation metadata', () => {
    const result = event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'message-2',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'untrusted raw output' }],
          isError: false,
        }],
      },
      meta: { runwrightValidation: { summary: '2 tests passed' } },
    })

    expect(translateSessionEvent(result, 1)).toEqual([
      { seq: 1, type: 'validation.completed', summary: '2 tests passed' },
    ])
    expect(translateSessionEvent(event('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'message-3',
        role: 'assistant',
        source: { kind: 'model' },
        content: [{ type: 'text', text: 'All tests passed' }],
      },
    }), 2).some(item => item.type === 'validation.completed')).toBe(false)
  })

  it.each([
    {
      name: 'completed',
      reason: { kind: 'completed' },
      expected: [{ seq: 1, type: 'run.succeeded', summary: 'Run completed' }],
    },
    {
      name: 'error',
      reason: { kind: 'error', error: { code: 'MODEL_UNAVAILABLE', message: 'secret provider detail' } },
      expected: [{ seq: 1, type: 'run.failed', errorCode: 'MODEL_UNAVAILABLE' }],
    },
    {
      name: 'user abort',
      reason: { kind: 'aborted', reason: { kind: 'user' } },
      expected: [{ seq: 1, type: 'run.cancelled' }],
    },
    {
      name: 'non-user abort',
      reason: { kind: 'aborted', reason: { kind: 'disposed' } },
      expected: [{ seq: 1, type: 'run.attention', reason: 'CANCEL_UNKNOWN' }],
    },
    {
      name: 'interrupted',
      reason: { kind: 'interrupted' },
      expected: [{ seq: 1, type: 'run.attention', reason: 'RUN_INTERRUPTED' }],
    },
    {
      name: 'max tokens',
      reason: { kind: 'max-tokens' },
      expected: [{ seq: 1, type: 'run.attention', reason: 'MAX_TOKENS' }],
    },
    {
      name: 'blocked',
      reason: { kind: 'blocked' },
      expected: [{ seq: 1, type: 'run.attention', reason: 'RUN_BLOCKED' }],
    },
  ])('maps turn/end $name to a stable outcome', ({ reason, expected }) => {
    expect(translateSessionEvent(event('turn/end', { turn: 1, reason }), 1)).toEqual(expected)
  })

  it('ignores unrelated durable events and sanitizes unknown error codes', () => {
    expect(translateSessionEvent(event('step/start', { turn: 1, step: 1 }), 1)).toEqual([])
    expect(translateSessionEvent(event('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'secret raw error', message: 'sensitive' } },
    }), 1)).toEqual([{ seq: 1, type: 'run.failed', errorCode: 'AGENT_ERROR' }])
  })
})
