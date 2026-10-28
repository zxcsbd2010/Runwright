interface DesktopToolExecution {
  readonly name: string
}

export interface DesktopSerializerContext {
  on(
    event: 'tools/execute',
    listener: <T>(exec: DesktopToolExecution, next: () => Promise<T>) => Promise<T>,
  ): (() => void) | void
}

export class DesktopSerializer {
  private tail: Promise<void> = Promise.resolve()
  private uninstall: (() => void) | undefined

  constructor(private readonly desktopToolNames: Iterable<string> = []) {}

  install(ctx: DesktopSerializerContext): void {
    this.uninstall?.()
    const names = new Set(this.desktopToolNames)
    const off = ctx.on('tools/execute', async (exec, next) => {
      if (!names.has(exec.name) && !exec.name.startsWith('cua_driver_native__')) return next()
      return await this.run(next)
    })
    this.uninstall = typeof off === 'function' ? off : undefined
  }

  dispose(): void {
    this.uninstall?.()
    this.uninstall = undefined
  }

  async run<T>(exclusiveTask: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await exclusiveTask()
    } finally {
      release()
    }
  }
}
