import { describe, expect, it, vi } from 'vitest'
import { apply } from './extensions.js'
import type { HostConnection, HostContext } from './extensions.js'

class FakeContext implements HostContext {
  readonly effects: Array<() => void | (() => void)> = []
  readonly error = vi.fn()
  readonly logger = { error: this.error }
  readonly off = vi.fn()
  readonly on = vi.fn().mockReturnValue(this.off)
  readonly sessionController = {
    create: vi.fn(),
    prompt: vi.fn(),
    cancel: vi.fn(),
    follow: vi.fn(),
  }
  readonly sessionQuery = { observeSession: vi.fn() }

  effect(effect: () => void | (() => void)): void {
    this.effects.push(effect)
  }
}

function connection(overrides: Partial<HostConnection> = {}): HostConnection {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    ...overrides,
  }
}

describe('NEXT Host lifecycle', () => {
  it('installs and disposes real tool guards with the Host effect', async () => {
    const ctx = new FakeContext()
    const runtime = connection()

    apply(ctx, () => runtime)
    const dispose = ctx.effects[0]!() as () => void

    expect(ctx.on).toHaveBeenCalledWith('tools/pre-execute', expect.any(Function))
    expect(ctx.on).toHaveBeenCalledWith('tools/execute', expect.any(Function))
    dispose()
    expect(ctx.off).toHaveBeenCalledTimes(2)
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })

  it('starts inside Cordis effect and disposes the same connection', async () => {
    const ctx = new FakeContext()
    const runtime = connection()

    apply(ctx, () => runtime)
    expect(ctx.effects).toHaveLength(1)
    const dispose = ctx.effects[0]!()
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1))
    expect(typeof dispose).toBe('function')
    ;(dispose as () => void)()
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })

  it('isolates initialization failures without registering effects or throwing', () => {
    const ctx = new FakeContext()

    expect(() => apply(ctx, () => { throw new Error('secret initialization detail') })).not.toThrow()
    expect(ctx.effects).toHaveLength(0)
    expect(ctx.error).toHaveBeenCalledWith('runwright-next-adapter: initialization failed')
    expect(ctx.error).not.toHaveBeenCalledWith(expect.stringContaining('secret'))
  })

  it('contains Host effect initialization failures and disposes the connection', () => {
    const ctx = new FakeContext()
    ctx.on.mockImplementation(() => { throw new Error('secret hook detail') })
    const runtime = connection()
    apply(ctx, () => runtime)

    expect(() => ctx.effects[0]!()).not.toThrow()
    expect(ctx.error).toHaveBeenCalledWith('runwright-next-adapter: initialization failed')
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })

  it('attempts every cleanup when a disposer fails during initialization', () => {
    const ctx = new FakeContext()
    ctx.off.mockImplementation(() => { throw new Error('secret dispose detail') })
    ctx.on.mockReturnValueOnce(ctx.off).mockImplementationOnce(() => { throw new Error('secret hook detail') })
    const runtime = connection()
    apply(ctx, () => runtime)

    expect(() => ctx.effects[0]!()).not.toThrow()
    expect(ctx.error).toHaveBeenCalledWith('runwright-next-adapter: initialization failed')
    expect(ctx.off).toHaveBeenCalledTimes(1)
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })

  it('contains asynchronous startup failures and still supports disposal', async () => {
    const ctx = new FakeContext()
    const runtime = connection({ start: vi.fn().mockRejectedValue(new Error('secret socket detail')) })
    apply(ctx, () => runtime)

    const dispose = ctx.effects[0]!() as () => void
    await vi.waitFor(() => {
      expect(ctx.error).toHaveBeenCalledWith('runwright-next-adapter: startup failed')
    })
    dispose()
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })
})
