import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionPolicy } from '@runwright/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopSerializer } from './desktop-serializer.js'
import { ExecutionGuard } from './execution-guard.js'
import type { ToolExecution } from './execution-guard.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'runwright-execution-guard-'))
  roots.push(root)
  return root
}

function policy(requireApprovalFor: ExecutionPolicy['requireApprovalFor'] = []): ExecutionPolicy {
  return { allowedTools: [], requireApprovalFor }
}

function execution(root: string, name: string, args: unknown, sessionId = 'runwright-session'): ToolExecution {
  return {
    name,
    arguments: args,
    agent: { session: { id: sessionId, header: { cwd: root } } },
  }
}

describe('ExecutionGuard', () => {
  it('delegates unrelated Sessions and ordinary project tools to NEXT native policy', async () => {
    const root = await project()
    const guard = new ExecutionGuard()
    guard.register({ sessionId: 'runwright-session', rootPath: root, policy: policy() })
    const next = vi.fn().mockResolvedValue({ kind: 'allow' })

    await expect(guard.evaluate(execution(root, 'fs/write', { path: 'src/a.ts' }, 'other'), next))
      .resolves.toEqual({ kind: 'allow' })
    await expect(guard.evaluate(execution(root, 'fs/write', { path: 'src/a.ts' }), next))
      .resolves.toEqual({ kind: 'allow' })
    await expect(guard.evaluate(execution(root, 'shell', { command: 'pnpm test' }), next))
      .resolves.toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledTimes(3)
  })

  it('enforces the configured tool allowlist only for Runwright Sessions', async () => {
    const root = await project()
    const guard = new ExecutionGuard()
    guard.register({
      sessionId: 'runwright-session',
      rootPath: root,
      policy: { allowedTools: ['fs/read'], requireApprovalFor: [] },
    })

    await expect(guard.evaluate(execution(root, 'fs/write', { path: 'a.ts' }), vi.fn()))
      .resolves.toMatchObject({ kind: 'deny', reason: 'TOOL_NOT_ALLOWED' })
  })

  it('asks for configured outside-project access and denies it otherwise', async () => {
    const root = await project()
    const outside = join(root, '..', 'outside.txt')
    const asking = new ExecutionGuard()
    asking.register({ sessionId: 'runwright-session', rootPath: root, policy: policy(['outside_project']) })
    const denying = new ExecutionGuard()
    denying.register({ sessionId: 'runwright-session', rootPath: root, policy: policy() })

    await expect(asking.evaluate(execution(root, 'fs/read', { path: outside }), vi.fn()))
      .resolves.toMatchObject({ kind: 'ask', reason: 'outside_project' })
    await expect(denying.evaluate(execution(root, 'fs/read', { path: outside }), vi.fn()))
      .resolves.toMatchObject({ kind: 'deny', reason: 'outside_project' })
  })

  it('checks the real NEXT file_path argument', async () => {
    const root = await project()
    const guard = new ExecutionGuard()
    guard.register({ sessionId: 'runwright-session', rootPath: root, policy: policy() })

    await expect(guard.evaluate(execution(root, 'write', { file_path: '/tmp/outside', content: 'x' }), vi.fn()))
      .resolves.toMatchObject({ kind: 'deny', reason: 'outside_project' })
  })

  it('resolves symlinks and existing parents before checking project containment', async () => {
    const root = await project()
    const outsideRoot = await project()
    await writeFile(join(outsideRoot, 'secret.txt'), 'fixture')
    await symlink(outsideRoot, join(root, 'linked'))
    const guard = new ExecutionGuard()
    guard.register({ sessionId: 'runwright-session', rootPath: root, policy: policy() })

    await expect(guard.evaluate(execution(root, 'fs/read', { path: 'linked/secret.txt' }), vi.fn()))
      .resolves.toMatchObject({ kind: 'deny', reason: 'outside_project' })
    await expect(guard.evaluate(execution(root, 'fs/write', { path: 'linked/new/file.ts' }), vi.fn()))
      .resolves.toMatchObject({ kind: 'deny', reason: 'outside_project' })
  })

  it.each([
    ['commit', 'shell', { command: 'git commit -m fixture' }],
    ['push', 'shell', { command: 'git push origin feature' }],
    ['deploy', 'shell', { command: 'pnpm deploy production' }],
    ['external_message', 'slack/send', { channel: 'general', text: 'fixture' }],
    ['commit', 'shell', { command: 'GIT_EDITOR=true git commit -m fixture' }],
    ['commit', 'shell', { command: '/usr/bin/git commit -m fixture' }],
    ['commit', 'shell', { command: 'env git commit -m fixture' }],
    ['push', 'shell', { command: "sh -c 'git push origin feature'" }],
    ['push', 'shell', { command: 'git status\ngit push origin feature' }],
    ['deploy', 'shell', { command: 'pnpm test\r\npnpm run deploy' }],
    ['deploy', 'shell', { command: 'pnpm run deploy' }],
  ] as const)('requires native approval for configured %s side effects', async (requirement, name, args) => {
    const root = await project()
    const guard = new ExecutionGuard()
    guard.register({ sessionId: 'runwright-session', rootPath: root, policy: policy([requirement]) })

    await expect(guard.evaluate(execution(root, name, args), vi.fn()))
      .resolves.toMatchObject({ kind: 'ask', reason: requirement })
  })

  it('delegates tools without a Session and fails closed for incomplete Runwright metadata', async () => {
    const root = await project()
    const guard = new ExecutionGuard()
    guard.register({ sessionId: 'runwright-session', rootPath: root, policy: policy() })
    const next = vi.fn().mockResolvedValue({ kind: 'allow' })

    await expect(guard.evaluate({ name: 'shell', arguments: { command: 'pnpm test' } }, next))
      .resolves.toEqual({ kind: 'allow' })
    await expect(guard.evaluate({
      name: 'fs/read',
      arguments: { path: 'a.ts' },
      agent: { session: { id: 'runwright-session', header: {} } },
    }, next)).resolves.toMatchObject({ kind: 'deny', reason: 'outside_project' })
  })

  it.each(['workdir', 'cwd'])('checks the execution %s for project containment', async key => {
    const root = await project()
    const guard = new ExecutionGuard()
    guard.register({ sessionId: 'runwright-session', rootPath: root, policy: policy() })

    await expect(guard.evaluate(execution(root, 'shell', { command: 'pnpm test', [key]: '/tmp' }), vi.fn()))
      .resolves.toMatchObject({ kind: 'deny', reason: 'outside_project' })
  })

  it('checks absolute paths embedded in shell commands', async () => {
    const root = await project()
    const guard = new ExecutionGuard()
    guard.register({ sessionId: 'runwright-session', rootPath: root, policy: policy() })

    await expect(guard.evaluate(execution(root, 'shell', { command: 'cat /tmp/outside' }), vi.fn()))
      .resolves.toMatchObject({ kind: 'deny', reason: 'outside_project' })
  })

  it('checks relative parent paths embedded in shell commands', async () => {
    const root = await project()
    const guard = new ExecutionGuard()
    guard.register({ sessionId: 'runwright-session', rootPath: root, policy: policy() })

    await expect(guard.evaluate(execution(root, 'shell', { command: 'cat ../../outside-secret' }), vi.fn()))
      .resolves.toMatchObject({ kind: 'deny', reason: 'outside_project' })
  })

  it.each([
    ['commit', 'git -c user.name=fixture commit -m fixture'],
    ['push', 'git -C . push origin feature'],
    ['commit', 'git --git-dir .git commit -m fixture'],
    ['commit', 'git --work-tree . commit -m fixture'],
    ['commit', 'git -c user.name="John Doe" commit -m fixture'],
  ] as const)('recognizes %s after Git global options', async (requirement, command) => {
    const root = await project()
    const guard = new ExecutionGuard()
    guard.register({ sessionId: 'runwright-session', rootPath: root, policy: policy([requirement]) })

    await expect(guard.evaluate(execution(root, 'shell', { command }), vi.fn()))
      .resolves.toMatchObject({ kind: 'ask', reason: requirement })
  })

  it('does not classify read-only tools or test filters as side effects', async () => {
    const root = await project()
    const guard = new ExecutionGuard()
    guard.register({ sessionId: 'runwright-session', rootPath: root, policy: policy() })
    const next = vi.fn().mockResolvedValue({ kind: 'allow' })

    await expect(guard.evaluate(execution(root, 'git_commit_log', {}), next)).resolves.toEqual({ kind: 'allow' })
    await expect(guard.evaluate(execution(root, 'shell', { command: 'pnpm test -- --grep deploy' }), next))
      .resolves.toEqual({ kind: 'allow' })
  })

  it('installs one pre-execute listener and restores NEXT policy on disposal', async () => {
    const root = await project()
    const off = vi.fn()
    const on = vi.fn().mockReturnValue(off)
    const guard = new ExecutionGuard()
    guard.register({ sessionId: 'runwright-session', rootPath: root, policy: policy() })
    guard.install({ on })

    expect(on).toHaveBeenCalledWith('tools/pre-execute', expect.any(Function))
    guard.dispose()
    expect(off).toHaveBeenCalledTimes(1)
    await expect(guard.evaluate(execution(root, 'fs/read', { path: 'a.ts' }), vi.fn().mockResolvedValue({ kind: 'allow' })))
      .resolves.toEqual({ kind: 'allow' })
  })
})

describe('DesktopSerializer', () => {
  it('serializes desktop tasks while leaving non-desktop work independent', async () => {
    const serializer = new DesktopSerializer()
    const events: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    const first = serializer.run(async () => {
      events.push('first:start')
      await gate
      events.push('first:end')
    })
    const second = serializer.run(async () => { events.push('second') })
    const ordinary = Promise.resolve().then(() => { events.push('ordinary') })
    await ordinary
    releaseFirst()
    await Promise.all([first, second])

    expect(events.indexOf('second')).toBeGreaterThan(events.indexOf('first:end'))
    expect(events).toContain('ordinary')
    expect(events).toHaveLength(4)
  })

  it('releases the desktop lock after failure', async () => {
    const serializer = new DesktopSerializer()
    await expect(serializer.run(async () => { throw new Error('fixture') })).rejects.toThrow('fixture')
    await expect(serializer.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('serializes native CUA tools without additional configuration', async () => {
    let listener!: (exec: ToolExecution, next: () => Promise<void>) => Promise<void>
    const serializer = new DesktopSerializer()
    serializer.install({
      on: (_event, registered) => {
        listener = registered
        return () => {}
      },
    })
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const exec = execution('/project', 'cua_driver_native__click', {})
    const first = listener(exec, async () => {
      events.push('first:start')
      await gate
      events.push('first:end')
    })
    const second = listener(exec, async () => { events.push('second') })
    release()
    await Promise.all([first, second])

    expect(events).toEqual(['first:start', 'first:end', 'second'])
    serializer.dispose()
  })

  it('wraps only configured desktop tools in the real tools/execute hook', async () => {
    const off = vi.fn()
    const on = vi.fn().mockReturnValue(off)
    const serializer = new DesktopSerializer(['mcp__desktop__computer'])
    serializer.install({ on })
    const listener = on.mock.calls[0]![1] as (
      exec: ToolExecution,
      next: () => Promise<string>,
    ) => Promise<string>
    const next = vi.fn().mockResolvedValue('result')

    await expect(listener(execution('/project', 'fs/read', {}), next)).resolves.toBe('result')
    await expect(listener(execution('/project', 'mcp__desktop__computer', {}), next)).resolves.toBe('result')
    expect(on).toHaveBeenCalledWith('tools/execute', expect.any(Function))
    expect(next).toHaveBeenCalledTimes(2)
    serializer.dispose()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
