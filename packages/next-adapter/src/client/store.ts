import type { Project, Task, TaskDetail } from '@runwright/contracts'

export interface RunwrightFollowFrame {
  kind: 'baseline' | 'increment'
  revision: number
  phase: 'ready' | 'offline'
  projects: Project[]
  tasks: Task[]
  details: Record<string, TaskDetail>
}

export type RunwrightPhase = 'connecting' | 'ready' | 'offline'

export interface RunwrightState {
  phase: RunwrightPhase
  revision: number
  projects: Project[]
  tasks: Task[]
  details: Record<string, TaskDetail>
}

type Listener = () => void

export class RunwrightStore {
  private state: RunwrightState = {
    phase: 'connecting',
    revision: -1,
    projects: [],
    tasks: [],
    details: {},
  }
  private readonly listeners = new Set<Listener>()

  getSnapshot = (): RunwrightState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  applyBaseline(frame: RunwrightFollowFrame): void {
    if (frame.kind !== 'baseline') throw new Error('opening frame must be a baseline')
    this.replace(frame)
  }

  applyIncrement(frame: RunwrightFollowFrame): void {
    if (frame.kind !== 'increment' || frame.revision <= this.state.revision) return
    this.replace(frame)
  }

  setOffline(): void {
    if (this.state.phase === 'offline') return
    this.state = { ...this.state, phase: 'offline' }
    this.emit()
  }

  private replace(frame: RunwrightFollowFrame): void {
    this.state = {
      phase: frame.phase,
      revision: frame.revision,
      projects: frame.projects,
      tasks: frame.tasks,
      details: frame.details,
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
