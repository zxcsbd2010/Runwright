// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Project, Task, TaskDetail } from '@runwright/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunwrightWorkbench } from './workbench.js'
import type { RunwrightWorkbenchProps } from './workbench.js'

const project: Project = {
  id: 'project-1',
  name: 'Demo',
  rootPath: '/picked/demo',
  createdAt: '2026-10-27T00:00:00.000Z',
}

function task(id: string, status: Task['status']): Task {
  return {
    id,
    projectId: project.id,
    prompt: `Prompt for ${id}`,
    status,
    activeRunId: `run-${id}`,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  }
}

function detail(value: Task, validationSummary?: string): TaskDetail {
  return {
    task: value,
    runs: [{
      id: `run-${value.id}`,
      taskId: value.id,
      attempt: 1,
      sessionId: `session-${value.id}`,
      status: value.status,
    }],
    ...(validationSummary === undefined ? {} : { validationSummary }),
  }
}

function props(overrides: Partial<RunwrightWorkbenchProps> = {}): RunwrightWorkbenchProps {
  return {
    phase: 'ready',
    projects: [],
    tasks: [],
    details: {},
    selectedProjectId: undefined,
    selectedTaskId: undefined,
    onSelectProject: vi.fn(),
    onRegisterProject: vi.fn(),
    onCreateTask: vi.fn(),
    onSelectTask: vi.fn(),
    onCancelTask: vi.fn(),
    onRetryTask: vi.fn(),
    onOpenSession: vi.fn(),
    ...overrides,
  }
}

afterEach(cleanup)

describe('RunwrightWorkbench', () => {
  it('renders an empty project state without an arbitrary browser path input', () => {
    render(<RunwrightWorkbench {...props()} />)

    expect(screen.getByText('暂无项目')).not.toBeNull()
    expect(screen.getByRole('button', { name: '注册项目' })).not.toBeNull()
    expect(screen.queryByLabelText('项目路径')).toBeNull()
  })

  it('shows queued and approval states and the exact missing-validation message', () => {
    const queued = task('task-queued', 'queued')
    const approval = task('task-approval', 'waiting_approval')
    render(<RunwrightWorkbench {...props({
      projects: [project],
      tasks: [queued, approval],
      details: {
        [queued.id]: detail(queued),
        [approval.id]: detail(approval),
      },
      selectedProjectId: project.id,
      selectedTaskId: queued.id,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '展开工作台概览' }))
    const taskList = within(screen.getByRole('region', { name: '任务列表' }))
    expect(taskList.getByText('queued')).not.toBeNull()
    expect(taskList.getByText('waiting_approval')).not.toBeNull()
    expect(screen.getByText('未提供结构化验证结果')).not.toBeNull()
    expect(screen.queryByText('测试通过')).toBeNull()
  })

  it('shows a successful run summary without translating it into a test-pass claim', () => {
    const succeeded = task('task-success', 'succeeded')
    render(<RunwrightWorkbench {...props({
      projects: [project],
      tasks: [succeeded],
      details: { [succeeded.id]: detail(succeeded, '构建完成，0 个错误') },
      selectedProjectId: project.id,
      selectedTaskId: succeeded.id,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '展开工作台概览' }))
    expect(screen.getByText('构建完成，0 个错误')).not.toBeNull()
    expect(screen.queryByText('测试通过')).toBeNull()
  })

  it('delegates creation, cancellation, retry, and Result Session navigation through props', () => {
    const failed = task('task-failed', 'failed')
    const actions = props({
      projects: [project],
      tasks: [failed],
      details: { [failed.id]: detail(failed) },
      selectedProjectId: project.id,
      selectedTaskId: failed.id,
    })
    render(<RunwrightWorkbench {...actions} />)

    fireEvent.click(screen.getByRole('button', { name: '展开工作台概览' }))
    fireEvent.change(screen.getByLabelText('需求'), { target: { value: 'Fix the failure' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    fireEvent.click(screen.getByRole('button', { name: '打开 Result Session' }))

    expect(actions.onCreateTask).toHaveBeenCalledWith('Fix the failure')
    expect(actions.onCancelTask).toHaveBeenCalledWith(failed.id)
    expect(actions.onRetryTask).toHaveBeenCalledWith(failed.id)
    expect(actions.onOpenSession).toHaveBeenCalledWith(failed.id)
  })

  it('discloses the real task overview through its toggle', () => {
    const queued = task('task-queued', 'queued')
    render(<RunwrightWorkbench {...props({
      projects: [project],
      tasks: [queued],
      details: { [queued.id]: detail(queued) },
      selectedProjectId: project.id,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '展开工作台概览' }))

    expect(screen.getByRole('region', { name: '工作台概览' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '取消' })).not.toBeNull()
  })

  it('opens the original session for a task waiting for native approval', () => {
    const approval = task('task-approval', 'waiting_approval')
    const actions = props({
      projects: [project],
      tasks: [approval],
      details: { [approval.id]: detail(approval) },
      selectedProjectId: project.id,
    })
    render(<RunwrightWorkbench {...actions} />)

    fireEvent.click(screen.getByRole('button', { name: '打开审批 Session' }))

    expect(actions.onOpenSession).toHaveBeenCalledWith(approval.id)
  })

  it('opens the command palette with the keyboard and discloses development tasks', () => {
    render(<RunwrightWorkbench {...props({ projects: [project], selectedProjectId: project.id })} />)

    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    fireEvent.click(screen.getByRole('button', { name: '查看研发任务' }))

    expect(screen.getByRole('button', { name: '收起工作台概览' })).not.toBeNull()
  })
})
