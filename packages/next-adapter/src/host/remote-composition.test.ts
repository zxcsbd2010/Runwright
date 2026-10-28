import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../extensions.js'
import type { HostConnection, HostContext } from '../extensions.js'
import { RunwrightRemoteFacade } from './remote-facade.js'

describe('Runwright Remote Host composition', () => {
  it('registers the facade when the shared connection supports Core calls', async () => {
    const ctx = new Context()
    const connection: HostConnection = {
      start: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      call: vi.fn(),
    } as HostConnection

    try {
      apply(ctx as unknown as HostContext, () => connection)

      expect(ctx.get('runwright')).toBeInstanceOf(RunwrightRemoteFacade)
      await vi.waitFor(() => expect(connection.start).toHaveBeenCalledTimes(1))
    } finally {
      await ctx.fiber.dispose()
    }
    expect(connection.dispose).toHaveBeenCalledTimes(1)
  })
})
