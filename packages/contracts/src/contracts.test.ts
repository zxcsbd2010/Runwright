import { readFileSync } from 'node:fs'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { RuntimeDriver, RuntimeEvent } from './index.js'
import {
  attachRunInputSchema,
  coreResponseSchema,
  runtimeEventSchema,
  runtimeHelloSchema,
  startRunInputSchema,
} from './schemas.js'

const hello = {
  protocolMajor: 1,
  adapterVersion: '0.1.0',
  runtimeId: 'next-local',
  runtimeKind: 'next',
  dshVersion: '0.2.1-rc.3',
  nextVersion: '2.0.20-next',
  capabilities: ['session.start'],
} as const

const project = {
  id: 'project-1',
  name: 'Example',
  rootPath: '/tmp/example',
  createdAt: '2026-10-27T00:00:00.000Z',
}

const policy = {
  allowedTools: ['fs/read', 'fs/write', 'shell/test'],
  requireApprovalFor: ['commit', 'push', 'deploy', 'external_message', 'outside_project'],
} as const

describe('runtimeEventSchema', () => {
  it('rejects a non-positive event sequence', () => {
    expect(runtimeEventSchema.safeParse({ seq: 0, type: 'run.started' }).success).toBe(false)
    expect(runtimeEventSchema.safeParse({ seq: 1.5, type: 'run.started' }).success).toBe(false)
  })

  it('accepts every specified runtime event variant', () => {
    const events: RuntimeEvent[] = [
      { seq: 1, type: 'run.started' },
      { seq: 2, type: 'run.progress', summary: 'editing' },
      { seq: 3, type: 'approval.requested', approvalId: 'approval-1' },
      { seq: 4, type: 'validation.completed', summary: '2 tests passed' },
      { seq: 5, type: 'run.succeeded', summary: 'done' },
      { seq: 6, type: 'run.failed', errorCode: 'MODEL_FAILED' },
      { seq: 7, type: 'run.attention', reason: 'unknown outcome' },
    ]

    for (const event of events) {
      expect(runtimeEventSchema.parse(event)).toEqual(event)
    }
  })

  it('rejects a missing variant payload', () => {
    expect(runtimeEventSchema.safeParse({ seq: 1, type: 'run.failed' }).success).toBe(false)
  })
})

describe('runtimeHelloSchema', () => {
  it('accepts only protocol major version one and NEXT runtimes', () => {
    expect(runtimeHelloSchema.parse(hello)).toEqual(hello)
    expect(runtimeHelloSchema.safeParse({ ...hello, protocolMajor: 2 }).success).toBe(false)
    expect(runtimeHelloSchema.safeParse({ ...hello, runtimeKind: 'sdk' }).success).toBe(false)
  })
})

describe('runtime input schemas', () => {
  it('validates start and attach inputs', () => {
    const start = { runId: 'run-1', project, prompt: 'add parser', policy }
    expect(startRunInputSchema.parse(start)).toEqual(start)
    expect(startRunInputSchema.safeParse({ ...start, prompt: '' }).success).toBe(false)
    expect(attachRunInputSchema.parse({ runId: 'run-1', sessionId: 'session-1', afterSeq: 4 })).toEqual({
      runId: 'run-1',
      sessionId: 'session-1',
      afterSeq: 4,
    })
    expect(attachRunInputSchema.safeParse({ runId: 'run-1', sessionId: 'session-1', afterSeq: -1 }).success).toBe(false)
  })
})

describe('coreResponseSchema', () => {
  it('keeps RPC errors limited to a code and message', () => {
    const response = {
      id: 'request-1',
      error: { code: 'UNAUTHORIZED', message: 'invalid credentials' },
    }
    expect(coreResponseSchema.parse(response)).toEqual(response)
    expect(coreResponseSchema.safeParse({
      ...response,
      error: { ...response.error, request: { prompt: 'secret prompt' } },
    }).success).toBe(false)
  })
})

it('exposes the runtime driver contract without framework dependencies', () => {
  expectTypeOf<Awaited<ReturnType<RuntimeDriver['startRun']>>>().toEqualTypeOf<{
    runtimeId: string
    runId: string
    sessionId: string
  }>()
})

it('uses the Runwright workspace and package identity', () => {
  const readPackage = (path: string): { name: string } => JSON.parse(
    readFileSync(new URL(path, import.meta.url), 'utf8'),
  ) as { name: string }

  expect(readPackage('../package.json').name).toBe('@runwright/contracts')
  expect(readPackage('../../../package.json').name).toBe('runwright-workbench')
})
