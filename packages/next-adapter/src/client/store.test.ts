import type { Project, Task, TaskDetail } from '@runwright/contracts'
import { describe, expect, it, vi } from 'vitest'
import { RunwrightStore } from './store.js'
import type { RunwrightFollowFrame } from './store.js'

const project: Project = {
  id: 'project-1',
  name: 'Demo',
  rootPath: '/picked/demo',
  createdAt: '2026-10-27T00:00:00.000Z',
}

const queued: Task = {
  id: 'task-1',
  projectId: project.id,
  prompt: 'Implement the feature',
  status: 'queued',
  activeRunId: 'run-1',
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z',
}

const detail: TaskDetail = {
  task: queued,
  runs: [{ id: 'run-1', taskId: queued.id, attempt: 1, status: 'queued' }],
}

function frame(kind: 'baseline' | 'increment', revision: number): RunwrightFollowFrame {
  return { kind, revision, phase: 'ready', projects: [project], tasks: [queued], details: { [queued.id]: detail } }
}

describe('RunwrightStore', () => {
  it('starts empty and replaces all projections from a validated baseline', () => {
    const store = new RunwrightStore()
    const listener = vi.fn()
    store.subscribe(listener)

    expect(store.getSnapshot()).toMatchObject({ phase: 'connecting', projects: [], tasks: [], details: {} })
    store.applyBaseline(frame('baseline', 4))

    expect(store.getSnapshot()).toEqual({
      phase: 'ready',
      revision: 4,
      projects: [project],
      tasks: [queued],
      details: { [queued.id]: detail },
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('applies only newer increments and preserves projections while Core is offline', () => {
    const store = new RunwrightStore()
    store.applyBaseline(frame('baseline', 4))
    const beforeStale = store.getSnapshot()

    store.applyIncrement(frame('increment', 4))
    expect(store.getSnapshot()).toBe(beforeStale)

    store.applyIncrement(frame('increment', 5))
    expect(store.getSnapshot().revision).toBe(5)
    store.setOffline()
    expect(store.getSnapshot()).toMatchObject({
      phase: 'offline',
      projects: [project],
      tasks: [queued],
      details: { [queued.id]: detail },
    })
  })

  it('rejects malformed opening increments instead of accepting a partial projection', () => {
    const store = new RunwrightStore()

    expect(() => store.applyBaseline(frame('increment', 0))).toThrow('opening frame must be a baseline')
    expect(store.getSnapshot().phase).toBe('connecting')
  })
})
