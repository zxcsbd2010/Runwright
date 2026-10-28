import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { ApprovalRequirement, ExecutionPolicy } from '@runwright/contracts'

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

export interface ToolExecution {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: {
    readonly session: {
      readonly id: string
      readonly header: { readonly cwd?: string }
    }
  }
}

export interface ExecutionGuardSession {
  sessionId: string
  rootPath: string
  policy: ExecutionPolicy
}

export interface ExecutionGuardContext {
  on(
    event: 'tools/pre-execute',
    listener: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>,
  ): (() => void) | void
}

const PATH_KEYS = new Set(['path', 'filePath', 'file_path', 'source', 'destination', 'targetPath', 'workdir', 'cwd'])

export class ExecutionGuard {
  private readonly sessions = new Map<string, ExecutionGuardSession>()
  private readonly blocked = new Set<string>()
  private uninstall: (() => void) | undefined

  register(session: ExecutionGuardSession): void {
    this.blocked.delete(session.sessionId)
    this.sessions.set(session.sessionId, session)
  }

  block(sessionId: string): void {
    this.blocked.add(sessionId)
  }

  install(ctx: ExecutionGuardContext): void {
    this.uninstall?.()
    const off = ctx.on('tools/pre-execute', (exec, next) => this.evaluate(exec, next))
    this.uninstall = typeof off === 'function' ? off : undefined
  }

  dispose(): void {
    this.uninstall?.()
    this.uninstall = undefined
    this.sessions.clear()
    this.blocked.clear()
  }

  async evaluate(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    const sessionId = exec.agent?.session.id
    if (sessionId === undefined) return next()
    if (this.blocked.has(sessionId)) return { kind: 'deny', reason: 'RECOVERY_POLICY_REQUIRED' }
    const session = this.sessions.get(sessionId)
    if (session === undefined) return next()
    if (session.policy.allowedTools.length > 0 && !session.policy.allowedTools.includes(exec.name)) {
      return { kind: 'deny', reason: 'TOOL_NOT_ALLOWED' }
    }

    const sideEffect = classifySideEffect(exec)
    if (sideEffect !== undefined) return this.decide(session.policy, sideEffect)
    const outside = await this.hasOutsidePath(exec, session.rootPath)
    if (outside) return this.decide(session.policy, 'outside_project')
    return next()
  }

  private decide(policy: ExecutionPolicy, requirement: ApprovalRequirement): PreToolDecision {
    return policy.requireApprovalFor.includes(requirement)
      ? { kind: 'ask', reason: requirement }
      : { kind: 'deny', reason: requirement }
  }

  private async hasOutsidePath(exec: ToolExecution, rootPath: string): Promise<boolean> {
    const cwd = exec.agent?.session.header.cwd
    if (cwd === undefined || !isAbsolute(cwd)) return true
    const paths = pathArguments(exec.arguments)
    for (const path of paths) {
      const candidate = isAbsolute(path) ? path : resolve(cwd, path)
      const [realRoot, realCandidate] = await Promise.all([
        realpath(rootPath),
        realpathWithMissingTail(candidate),
      ])
      const rel = relative(realRoot, realCandidate)
      if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
        return true
      }
    }
    return false
  }
}

export function installExecutionGuard(ctx: ExecutionGuardContext): ExecutionGuard {
  const guard = new ExecutionGuard()
  guard.install(ctx)
  return guard
}

function classifySideEffect(exec: ToolExecution): Exclude<ApprovalRequirement, 'outside_project'> | undefined {
  const name = exec.name.toLowerCase()
  const command = commandArgument(exec.arguments).toLowerCase()
  if (isTool(name, 'commit') || gitCommand(command, 'commit')) return 'commit'
  if (isTool(name, 'push') || gitCommand(command, 'push')) return 'push'
  if (isTool(name, 'deploy') || /(^|[;&|\r\n]\s*)(?:(pnpm|npm|yarn|bun)(\s+run)?\s+)?deploy(\s|$)/.test(command)) {
    return 'deploy'
  }
  if (/(slack|email|mail|webhook|teams|discord)/.test(name) && /(send|post|external_message)/.test(name)) {
    return 'external_message'
  }
  return undefined
}

function isTool(name: string, action: string): boolean {
  return name === action || name.endsWith(`/${action}`) || name.endsWith(`__${action}`)
}

function gitCommand(command: string, action: 'commit' | 'push'): boolean {
  const value = '(?:\\S+="[^"]*"|\\S+=\'[^\']*\'|"[^"]*"|\'[^\']*\'|\\S+)'
  const option = `(?:-c\\s+${value}|-C\\s+${value}|--(?:git-dir|work-tree)(?:=${value}|\\s+${value})|--\\S+)`
  const prefix = '(?:\\S+=\\S+\\s+|env\\s+|(?:\\S+/)?(?:sh|bash|zsh)\\s+-c\\s+[\'\"]?)*'
  const pattern = `(^|[;&|\r\n]\\s*)${prefix}(?:\\S+/)?git(?:\\s+${option})*\\s+${action}(\\s|$)`
  return new RegExp(pattern, 'i').test(command)
}

function commandArgument(args: unknown): string {
  if (typeof args !== 'object' || args === null || !('command' in args)) return ''
  return typeof args.command === 'string' ? args.command : ''
}

function pathArguments(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return []
  const paths: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (PATH_KEYS.has(key) && typeof value === 'string' && value.length > 0) paths.push(value)
  }
  const command = commandArgument(args)
  for (const match of command.matchAll(/(?:^|[\s;&|])(?:"(\/[^"]+)"|'(\/[^']+)'|(\/[^\s;&|]+)|"((?:\.\.\/|\.\/)[^"]+)"|'((?:\.\.\/|\.\/)[^']+)'|((?:\.\.\/|\.\/)[^\s;&|]+))/g)) {
    paths.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6]!)
  }
  return paths
}

async function realpathWithMissingTail(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      const existing = await realpath(current)
      return resolve(existing, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw error
      missing.push(current.slice(dirname(current).length + 1))
      current = dirname(current)
    }
  }
}
