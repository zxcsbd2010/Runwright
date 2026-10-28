import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Project, Task, TaskDetail } from '@runwright/contracts'
import type { RunwrightPhase } from './store.js'

export interface RunwrightWorkbenchProps {
  phase: RunwrightPhase
  projects: Project[]
  tasks: Task[]
  details: Record<string, TaskDetail>
  selectedProjectId: string | undefined
  selectedTaskId: string | undefined
  onSelectProject(projectId: string): void
  onRegisterProject(): void
  onCreateTask(prompt: string): void
  onSelectTask(taskId: string): void
  onCancelTask(taskId: string): void
  onRetryTask(taskId: string): void
  onOpenSession(taskId: string): void
}

export function RunwrightWorkbench(props: RunwrightWorkbenchProps) {
  const [prompt, setPrompt] = useState('')
  const selectedTask = props.tasks.find(task => task.id === props.selectedTaskId)
  const selectedDetail = selectedTask ? props.details[selectedTask.id] : undefined

  const createTask = (event: FormEvent) => {
    event.preventDefault()
    if (!prompt.trim() || !props.selectedProjectId) return
    props.onCreateTask(prompt.trim())
    setPrompt('')
  }

  return <main aria-label="Runwright 工作台">
    <h1>Runwright</h1>
    {props.phase === 'offline' && <p role="status">Core 离线</p>}
    <section aria-label="项目">
      <h2>项目</h2>
      <button type="button" onClick={props.onRegisterProject}>注册项目</button>
      {props.projects.length === 0 ? <p>暂无项目</p> : <>
        <label htmlFor="runwright-project">当前项目</label>
        <select
          id="runwright-project"
          value={props.selectedProjectId ?? ''}
          onChange={event => props.onSelectProject(event.target.value)}
        >
          {props.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </>}
    </section>

    <form onSubmit={createTask}>
      <label htmlFor="runwright-prompt">需求</label>
      <textarea
        id="runwright-prompt"
        value={prompt}
        onChange={event => setPrompt(event.target.value)}
      />
      <button type="submit" disabled={!props.selectedProjectId}>创建任务</button>
    </form>

    <section aria-label="任务列表">
      <h2>任务列表</h2>
      {props.tasks.map(task => <article key={task.id}>
        <button type="button" onClick={() => props.onSelectTask(task.id)}>{task.prompt}</button>
        <span>{task.status}</span>
        <button type="button" onClick={() => props.onCancelTask(task.id)}>取消</button>
        <button type="button" onClick={() => props.onRetryTask(task.id)}>重试</button>
        <button
          type="button"
          disabled={!props.details[task.id]?.runs.some(run => run.sessionId)}
          onClick={() => props.onOpenSession(task.id)}
        >打开 Result Session</button>
      </article>)}
    </section>

    {selectedDetail && <section aria-label="任务详情">
      <h2>Run 历史</h2>
      <p>状态：{selectedDetail.task.status}</p>
      <ol>
        {selectedDetail.runs.map(run => <li key={run.id}>Attempt {run.attempt}：{run.status}</li>)}
      </ol>
      <h3>验证摘要</h3>
      <p>{selectedDetail.validationSummary ?? '未提供结构化验证结果'}</p>
    </section>}
  </main>
}
