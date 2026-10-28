import { useEffect, useRef, useState } from 'react'
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

const phaseLabels: Record<RunwrightPhase, string> = {
  connecting: 'Core 连接中',
  ready: 'Core 在线',
  offline: 'Core 离线',
}

const quickPrompts = [
  { label: '排查失败任务', prompt: '检查当前项目中的失败任务，分析原因并给出修复建议。' },
  { label: '审查当前项目', prompt: '审查当前项目最近的变更，关注行为回归和缺失的测试。' },
  { label: '继续未完成工作', prompt: '梳理当前项目中尚未完成的任务，并继续下一项高优先级工作。' },
]

const workbenchStyles = `
  .rw-workbench {
    --rw-bg: light-dark(#eef2f5, #090e14);
    --rw-shell: light-dark(#f8fafc, #0d141c);
    --rw-panel: light-dark(#ffffff, #111b25);
    --rw-panel-soft: light-dark(#f5f8fa, #0e1720);
    --rw-text: light-dark(#17232d, #e7eef5);
    --rw-muted: light-dark(#667684, #8b9aaa);
    --rw-line: light-dark(#dce4ea, #22303d);
    --rw-line-soft: light-dark(#e8edf1, #1a2631);
    --rw-accent: light-dark(#087f8c, #67e8f9);
    --rw-accent-soft: light-dark(#e2f4f5, #123039);
    --rw-green: light-dark(#18794e, #5bd6a0);
    --rw-amber: light-dark(#9a6700, #e7b416);
    min-height: 100%;
    color: var(--rw-text);
    color-scheme: light dark;
    background: var(--rw-shell);
    font-family: inherit;
    font-size: 13px;
  }
  .rw-workbench * { box-sizing: border-box; }
  .rw-workbench button, .rw-workbench textarea, .rw-workbench select { font: inherit; }
  .rw-workbench button { cursor: pointer; }
  .rw-workbench button:disabled { cursor: default; opacity: .45; }
  .rw-topbar {
    position: relative;
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr);
    align-items: center;
    gap: 20px;
    min-height: 68px;
    padding: 12px 32px;
    border-bottom: 1px solid var(--rw-line);
  }
  .rw-brand { display: flex; align-items: center; gap: 10px; }
  .rw-logo {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    color: light-dark(#ffffff, #08282e);
    background: var(--rw-accent);
    font-family: ui-monospace, monospace;
    font-weight: 600;
  }
  .rw-brand-name { display: block; font-weight: 600; }
  .rw-brand-sub { display: block; margin-top: 2px; color: var(--rw-muted); font-size: 12px; }
  .rw-project-select {
    min-height: 38px;
    max-width: 220px;
    padding: 7px 30px 7px 10px;
    border: 1px solid var(--rw-line);
    border-radius: 8px;
    color: var(--rw-text);
    background: var(--rw-panel-soft);
  }
  .rw-top-actions { display: flex; align-items: center; justify-self: end; gap: 10px; }
  .rw-status { color: var(--rw-green); font-size: 12px; white-space: nowrap; }
  .rw-status[data-phase='offline'] { color: var(--rw-amber); }
  .rw-command-button, .rw-secondary-button {
    min-height: 38px;
    padding: 7px 12px;
    border: 1px solid var(--rw-line);
    border-radius: 8px;
    color: var(--rw-text);
    background: var(--rw-panel-soft);
  }
  .rw-command-panel {
    position: absolute;
    top: 58px;
    right: 32px;
    z-index: 20;
    display: grid;
    gap: 6px;
    min-width: 230px;
    padding: 12px;
    border: 1px solid var(--rw-line);
    border-radius: 12px;
    background: var(--rw-panel);
    box-shadow: 0 18px 48px var(--rw-bg);
  }
  .rw-command-panel h2 { margin: 0 0 6px; font-size: 12px; font-weight: 500; color: var(--rw-muted); }
  .rw-command-panel button {
    min-height: 38px;
    padding: 8px 10px;
    border: 0;
    border-radius: 7px;
    color: var(--rw-text);
    background: transparent;
    text-align: left;
  }
  .rw-command-panel button:hover { background: var(--rw-accent-soft); }
  .rw-content { max-width: 1180px; margin: 0 auto; padding: 40px 32px 32px; }
  .rw-welcome { margin-bottom: 28px; }
  .rw-eyebrow { margin: 0 0 10px; color: var(--rw-accent); font-size: 12px; letter-spacing: .08em; }
  .rw-welcome h1 { margin: 0; font-size: 26px; line-height: 1.25; letter-spacing: -.03em; }
  .rw-welcome p:last-child { margin: 10px 0 0; color: var(--rw-muted); }
  .rw-hero { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(250px, .75fr); gap: 20px; }
  .rw-panel {
    min-width: 0;
    padding: 24px;
    border: 1px solid var(--rw-line);
    border-radius: 14px;
    background: var(--rw-panel);
  }
  .rw-ai-panel { background: linear-gradient(150deg, var(--rw-accent-soft), var(--rw-panel) 48%); }
  .rw-panel-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
  .rw-panel-heading h2 { margin: 0; font-size: 14px; font-weight: 600; }
  .rw-panel-heading span { margin-left: auto; color: var(--rw-muted); font-size: 12px; }
  .rw-prompt-label { display: block; margin-bottom: 10px; font-weight: 500; }
  .rw-composer {
    padding: 16px;
    border: 1px solid var(--rw-accent);
    border-radius: 12px;
    background: var(--rw-panel-soft);
  }
  .rw-composer:focus-within { box-shadow: 0 0 0 3px var(--rw-accent-soft); }
  .rw-composer textarea {
    display: block;
    width: 100%;
    min-height: 112px;
    padding: 0;
    resize: vertical;
    border: 0;
    color: var(--rw-text);
    background: transparent;
    line-height: 1.6;
  }
  .rw-composer-actions { display: flex; align-items: center; gap: 12px; padding-top: 12px; border-top: 1px solid var(--rw-line-soft); }
  .rw-composer-actions span { color: var(--rw-muted); font-size: 12px; }
  .rw-primary-button {
    min-height: 40px;
    margin-left: auto;
    padding: 8px 16px;
    border: 0;
    border-radius: 8px;
    color: light-dark(#ffffff, #08282e);
    background: var(--rw-accent);
    font-weight: 600;
  }
  .rw-quick-prompts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .rw-quick-prompts button {
    min-height: 36px;
    padding: 7px 11px;
    border: 1px solid var(--rw-line);
    border-radius: 8px;
    color: var(--rw-muted);
    background: var(--rw-panel-soft);
  }
  .rw-summary-count { color: var(--rw-amber) !important; }
  .rw-summary-empty { color: var(--rw-muted); }
  .rw-approval-item, .rw-current-task { padding: 16px 0; border-top: 1px solid var(--rw-line-soft); }
  .rw-approval-item strong, .rw-current-task strong { display: block; overflow-wrap: anywhere; }
  .rw-approval-item span, .rw-current-task span { display: block; margin-top: 6px; color: var(--rw-muted); font-size: 12px; }
  .rw-approval-item button { margin-top: 12px; }
  .rw-overview-toggle {
    display: block;
    min-width: 220px;
    min-height: 42px;
    margin: 24px auto 0;
    padding: 8px 16px;
    border: 1px solid var(--rw-line);
    border-radius: 22px;
    color: var(--rw-muted);
    background: var(--rw-panel-soft);
  }
  .rw-overview { margin-top: 20px; }
  .rw-overview-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(260px, 1fr); gap: 16px; }
  .rw-task-list { display: grid; gap: 8px; }
  .rw-task-item { padding: 14px; border: 1px solid var(--rw-line-soft); border-radius: 10px; background: var(--rw-panel-soft); }
  .rw-task-main { display: flex; align-items: flex-start; gap: 12px; }
  .rw-task-prompt {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    color: var(--rw-text);
    background: transparent;
    text-align: left;
    overflow-wrap: anywhere;
  }
  .rw-task-status { color: var(--rw-muted); font-size: 12px; white-space: nowrap; }
  .rw-task-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .rw-task-actions button { min-height: 34px; padding: 6px 9px; }
  .rw-detail h3 { margin: 18px 0 8px; font-size: 13px; }
  .rw-detail p, .rw-detail li { color: var(--rw-muted); line-height: 1.6; }
  .rw-detail ol { padding-left: 20px; }
  .rw-empty { color: var(--rw-muted); }
  .rw-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  @media (max-width: 820px) {
    .rw-hero, .rw-overview-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 560px) {
    .rw-topbar { grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; padding: 12px 14px; }
    .rw-brand-sub, .rw-status, .rw-command-button span { display: none; }
    .rw-project-select { width: 100%; max-width: 150px; }
    .rw-command-panel { right: 14px; }
    .rw-content { padding: 28px 14px; }
    .rw-welcome h1 { font-size: 22px; }
    .rw-panel { padding: 18px; }
    .rw-composer-actions { flex-wrap: wrap; }
    .rw-overview-toggle { width: 100%; min-width: 0; }
  }
  @media (prefers-reduced-motion: no-preference) {
    .rw-workbench button { transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease; }
  }
`

export function RunwrightWorkbench(props: RunwrightWorkbenchProps) {
  const [prompt, setPrompt] = useState('')
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const projectTasks = props.tasks.filter(task => !props.selectedProjectId || task.projectId === props.selectedProjectId)
  const approvalTasks = projectTasks.filter(task => task.status === 'waiting_approval')
  const selectedTask = projectTasks.find(task => task.id === props.selectedTaskId)
  const selectedDetail = selectedTask ? props.details[selectedTask.id] : undefined
  const currentProject = props.projects.find(project => project.id === props.selectedProjectId)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(open => !open)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const createTask = (event: FormEvent) => {
    event.preventDefault()
    if (!prompt.trim() || !props.selectedProjectId) return
    props.onCreateTask(prompt.trim())
    setPrompt('')
  }

  const focusPrompt = () => {
    setCommandOpen(false)
    promptRef.current?.focus()
  }

  const openTaskOverview = () => {
    setCommandOpen(false)
    setOverviewOpen(true)
  }

  return <main className="rw-workbench" aria-label="Runwright 工作台">
    <style>{workbenchStyles}</style>
    <header className="rw-topbar">
      <div className="rw-brand">
        <span className="rw-logo">R</span>
        <span><span className="rw-brand-name">Runwright</span><span className="rw-brand-sub">Personal AI</span></span>
      </div>
      <div>
        {props.projects.length === 0
          ? <button className="rw-secondary-button" type="button" onClick={props.onRegisterProject}>注册项目</button>
          : <>
            <label className="rw-sr-only" htmlFor="runwright-project">当前项目</label>
            <select
              className="rw-project-select"
              id="runwright-project"
              value={props.selectedProjectId ?? ''}
              onChange={event => props.onSelectProject(event.target.value)}
            >
              {props.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </>}
      </div>
      <div className="rw-top-actions">
        <span className="rw-status" data-phase={props.phase} role="status">{phaseLabels[props.phase]}</span>
        <button
          className="rw-command-button"
          type="button"
          aria-expanded={commandOpen}
          aria-controls="runwright-command-panel"
          onClick={() => setCommandOpen(open => !open)}
        >⌘K <span>命令</span></button>
      </div>
      {commandOpen && <section className="rw-command-panel" id="runwright-command-panel" aria-label="命令面板">
        <h2>快速操作</h2>
        <button type="button" onClick={focusPrompt}>新建任务</button>
        <button type="button" onClick={openTaskOverview}>查看研发任务</button>
        <button type="button" onClick={() => { setCommandOpen(false); props.onRegisterProject() }}>注册项目</button>
      </section>}
    </header>

    <div className="rw-content">
      <section className="rw-welcome" aria-labelledby="runwright-welcome">
        <p className="rw-eyebrow">PERSONAL AI WORKSPACE</p>
        <h1 id="runwright-welcome">今天想完成什么？</h1>
        <p>从一个想法开始，Runwright 会把它拆成可执行的研发工作。</p>
      </section>

      <div className="rw-hero">
        <section className="rw-panel rw-ai-panel" aria-labelledby="runwright-ai-heading">
          <div className="rw-panel-heading">
            <h2 id="runwright-ai-heading">AI 个人助手</h2>
            <span>{props.projects.length === 0 ? '暂无项目' : currentProject?.name ?? '未选择项目'}</span>
          </div>
          <form onSubmit={createTask}>
            <div className="rw-composer">
              <label className="rw-prompt-label" htmlFor="runwright-prompt">需求</label>
              <textarea
                ref={promptRef}
                id="runwright-prompt"
                value={prompt}
                placeholder="描述要实现的 feature、要修复的问题，或需要验证的工作…"
                onChange={event => setPrompt(event.target.value)}
              />
              <div className="rw-composer-actions">
                <span>{currentProject ? `发送到 ${currentProject.name}` : '先注册并选择一个项目'}</span>
                <button className="rw-primary-button" type="submit" disabled={!props.selectedProjectId}>创建任务</button>
              </div>
            </div>
          </form>
          <div className="rw-quick-prompts" aria-label="快捷指令">
            {quickPrompts.map(item => <button
              key={item.label}
              type="button"
              onClick={() => { setPrompt(item.prompt); promptRef.current?.focus() }}
            >{item.label}</button>)}
          </div>
        </section>

        <aside className="rw-panel" aria-label="今日摘要">
          <div className="rw-panel-heading">
            <h2>等待你处理</h2>
            <span className="rw-summary-count">{approvalTasks.length} 项待审批</span>
          </div>
          {approvalTasks.length === 0
            ? <p className="rw-summary-empty">没有待审批任务</p>
            : approvalTasks.map(task => <article className="rw-approval-item" key={task.id}>
              <strong>{task.prompt}</strong>
              <span>{task.status} · 在 DSH 原 Session 中审批</span>
              <button
                className="rw-secondary-button"
                type="button"
                disabled={!props.details[task.id]?.runs.some(run => run.sessionId)}
                onClick={() => props.onOpenSession(task.id)}
              >打开审批 Session</button>
            </article>)}
          {selectedTask && <article className="rw-current-task">
            <strong>当前任务</strong>
            <span>{selectedTask.status}</span>
            <p>{selectedTask.prompt}</p>
          </article>}
        </aside>
      </div>

      <button
        className="rw-overview-toggle"
        type="button"
        aria-expanded={overviewOpen}
        aria-controls="runwright-overview"
        onClick={() => setOverviewOpen(open => !open)}
      >{overviewOpen ? '收起工作台概览' : '展开工作台概览'}</button>

      {overviewOpen && <section className="rw-overview" id="runwright-overview" aria-label="工作台概览">
        <div className="rw-overview-grid">
          <section className="rw-panel" aria-label="任务列表">
            <div className="rw-panel-heading"><h2>研发任务</h2><span>{projectTasks.length} 项</span></div>
            {projectTasks.length === 0
              ? <p className="rw-empty">暂无研发任务</p>
              : <div className="rw-task-list">{projectTasks.map(task => <article className="rw-task-item" key={task.id}>
                <div className="rw-task-main">
                  <button className="rw-task-prompt" type="button" onClick={() => props.onSelectTask(task.id)}>{task.prompt}</button>
                  <span className="rw-task-status">{task.status}</span>
                </div>
                <div className="rw-task-actions">
                  <button className="rw-secondary-button" type="button" onClick={() => props.onCancelTask(task.id)}>取消</button>
                  <button className="rw-secondary-button" type="button" onClick={() => props.onRetryTask(task.id)}>重试</button>
                  <button
                    className="rw-secondary-button"
                    type="button"
                    disabled={!props.details[task.id]?.runs.some(run => run.sessionId)}
                    onClick={() => props.onOpenSession(task.id)}
                  >打开 Result Session</button>
                </div>
              </article>)}</div>}
          </section>

          {selectedDetail && <section className="rw-panel rw-detail" aria-label="任务详情">
            <div className="rw-panel-heading"><h2>任务详情</h2><span>{selectedDetail.task.status}</span></div>
            <h3>Run 历史</h3>
            <ol>
              {selectedDetail.runs.map(run => <li key={run.id}>Attempt {run.attempt}：{run.status}</li>)}
            </ol>
            <h3>验证摘要</h3>
            <p>{selectedDetail.validationSummary ?? '未提供结构化验证结果'}</p>
          </section>}
        </div>
      </section>}
    </div>
  </main>
}
