import type { RuntimeDriver, RuntimeHello } from '@runwright/contracts'

const requiredCapabilities = [
  'session.start',
  'session.attach',
  'session.cancel',
  'approval.forward',
  'validation.summary',
]

export class RuntimeRegistry {
  private runtimeId: string | undefined

  constructor(private readonly driver: RuntimeDriver) {}

  accept(hello: RuntimeHello): boolean {
    const compatible = hello.protocolMajor === 1
      && requiredCapabilities.every((capability) => hello.capabilities.includes(capability))
    this.runtimeId = compatible ? hello.runtimeId : undefined
    return compatible
  }

  resolve(): { runtimeId: string; driver: RuntimeDriver } {
    if (!this.runtimeId) throw new Error('RUNTIME_UNAVAILABLE')
    return { runtimeId: this.runtimeId, driver: this.driver }
  }
}
