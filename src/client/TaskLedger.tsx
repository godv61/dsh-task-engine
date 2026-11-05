/** Read-only task workbench. Documents are projections, never a second task store. */
import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Button, MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskEngineRemote, TaskLedgerEntry } from './TaskEngineSection.tsx'
import { describeError } from './shared.ts'
import { formatEastEightTime } from '../time.ts'
import { deliveryDetails, itemAudit, sonarAudit } from './TaskLedgerAudit.tsx'
import {
  evidenceLabel,
  intentLabel,
  lifecycleLabel,
  registeredFiles,
  requirementLabels,
  reviewLabel,
  taskDocument,
} from '../task-ledger-document.ts'
import { TASK_LEDGER_CSS } from './task-ledger-theme.ts'

const LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }
const TABS = [
  ['overview', '概览'],
  ['requirements', '需求与方案'],
  ['plan', '实施计划'],
  ['files', '文件范围'],
  ['verification', '验证与审核'],
] as const
type Tab = (typeof TABS)[number][0]
const time = (value?: string) => (value ? formatEastEightTime(value) : '未记录')
const pill = (text: string, tone?: string) => (
  <span className="tl-pill" data-tone={tone}>
    {text}
  </span>
)
const markdown = (text: string) => (
  <div className="tl-markdown">
    <MarkdownText text={text} labels={LABELS} />
  </div>
)
const section = (title: string, children: ReactNode, action?: ReactNode) => (
  <section className="tl-section">
    <div className="tl-section-title">
      <h3>{title}</h3>
      {action}
    </div>
    {children}
  </section>
)
async function timed<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('读取超时，请刷新重试')), 15000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function TaskLedger({
  workspace,
  remote,
}: {
  workspace: string
  remote: TaskEngineRemote
}): ReturnType<typeof createElement> {
  const [page, setPage] = useState<{
    workspace: string
    tasks: TaskLedgerEntry[]
    errors: { file: string; message: string }[]
    cursor?: string
    total: number
  }>({ workspace: '', tasks: [], errors: [], total: 0 })
  const [error, setError] = useState(''),
    [exportError, setExportError] = useState('')
  const [loading, setLoading] = useState(true),
    [loadingMore, setLoadingMore] = useState(false)
  const [query, setQuery] = useState(''),
    [risk, setRisk] = useState('all'),
    [stage, setStage] = useState('all'),
    [lifecycle, setLifecycle] = useState('open')
  const [selection, setSelection] = useState({ workspace: '', id: '' }),
    [tab, setTab] = useState<Tab>('overview'),
    [mode, setMode] = useState<'workbench' | 'document'>('workbench')
  const epoch = useRef(0),
    tabId = useId(),
    tasks = page.workspace === workspace ? page.tasks : []
  const refresh = useCallback(() => {
    const requestEpoch = ++epoch.current
    setLoadingMore(false)
    setError('')
    setExportError('')
    if (!workspace) {
      setLoading(false)
      return
    }
    setLoading(true)
    // The host validates positional arity even for an optional cursor.
    void timed(remote.readTasks(workspace, ''))
      .then((result) => {
        if (requestEpoch !== epoch.current) return
        if (!result.ok) throw new Error(describeError(result.error))
        setPage({
          workspace,
          tasks: result.value.tasks,
          errors: result.value.errors ?? [],
          cursor: result.value.next_cursor,
          total: result.value.total_count ?? result.value.tasks.length,
        })
      })
      .catch((reason: unknown) => {
        if (requestEpoch === epoch.current) setError('读取台账失败：' + describeError(reason))
      })
      .finally(() => {
        if (requestEpoch === epoch.current) setLoading(false)
      })
  }, [workspace, remote])
  useEffect(() => {
    setQuery('')
    setRisk('all')
    setStage('all')
    setLifecycle('open')
    setTab('overview')
    refresh()
    return () => {
      epoch.current++
    }
  }, [refresh])
  const loadMore = async () => {
    if (!page.cursor || page.workspace !== workspace || loading || loadingMore) return
    const requestEpoch = epoch.current
    setLoadingMore(true)
    setError('')
    try {
      const result = await timed(remote.readTasks(workspace, page.cursor))
      if (requestEpoch !== epoch.current) return
      if (!result.ok) throw new Error(describeError(result.error))
      setPage((previous) => ({
        ...previous,
        tasks: [...new Map([...previous.tasks, ...result.value.tasks].map((t) => [t.task_id, t])).values()],
        errors: [...previous.errors, ...(result.value.errors ?? [])],
        cursor: result.value.next_cursor,
        total: result.value.total_count ?? previous.total,
      }))
    } catch (reason) {
      if (requestEpoch === epoch.current) setError('加载失败：' + describeError(reason))
    } finally {
      if (requestEpoch === epoch.current) setLoadingMore(false)
    }
  }
  const visible = tasks
    .filter(
      (t) =>
        `${t.task_id} ${t.title} ${t.branch}`.toLowerCase().includes(query.toLowerCase()) &&
        (risk === 'all' || t.risk_level === risk) &&
        (stage === 'all' || t.stage === stage) &&
        (lifecycle === 'all' || (lifecycle === 'archived' ? t.lifecycle === 'archived' : t.lifecycle !== 'archived')),
    )
    .sort(
      (a, b) =>
        (b.updated_at ?? b.completed_at ?? '').localeCompare(a.updated_at ?? a.completed_at ?? '') ||
        a.task_id.localeCompare(b.task_id),
    )
  const selected = visible.find((t) => selection.workspace === workspace && t.task_id === selection.id) ?? visible[0]
  const go = (next: Tab) => {
    setTab(next)
    setMode('workbench')
  }
  const keyboardTab = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      e.key === 'ArrowRight'
        ? (index + 1) % TABS.length
        : e.key === 'ArrowLeft'
          ? (index + TABS.length - 1) % TABS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? TABS.length - 1
              : -1
    if (next < 0) return
    e.preventDefault()
    setTab(TABS[next]![0])
    e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }
  const download = () => {
    if (!selected) return
    try {
      const url = URL.createObjectURL(new Blob([taskDocument(selected)], { type: 'text/markdown;charset=utf-8' })),
        link = document.createElement('a')
      link.href = url
      link.download = `${selected.task_id}-task.md`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setExportError('')
    } catch (reason) {
      setExportError('导出失败：' + describeError(reason))
    }
  }
  return (
    <div className="te-ledger">
      <style>{TASK_LEDGER_CSS}</style>
      <div className="tl-row tl-between">
        <div>
          <h2>任务台账</h2>
          <p className="tl-caption">从需求确认到交付，关键信息一处查阅。</p>
        </div>
        <div className="tl-row">
          <span className="tl-sub tl-small">已载入 {tasks.length} 项</span>
          <Button variant="outline" size="sm" disabled={loading || !workspace} onClick={refresh}>
            {loading ? '读取中…' : '刷新'}
          </Button>
        </div>
      </div>
      {error && (
        <div role="alert" className="tl-errors">
          {error}
          {tasks.length > 0 && '；当前保留上次读取的内容。'}
        </div>
      )}
      {exportError && (
        <div role="alert" className="tl-errors">
          {exportError}
        </div>
      )}
      {page.workspace === workspace && page.errors.length > 0 && (
        <details className="tl-errors">
          <summary>有 {page.errors.length} 份任务记录无法读取</summary>
          {page.errors.map((e) => (
            <p key={e.file}>
              {e.file}：{e.message}
            </p>
          ))}
        </details>
      )}
      {!workspace ? (
        <p className="tl-empty">请先选择项目工作区。</p>
      ) : loading && tasks.length === 0 ? (
        <p className="tl-empty" role="status">
          正在读取任务…
        </p>
      ) : tasks.length === 0 ? (
        <p className="tl-empty">
          {error
            ? '尚未读取到当前工作区数据，请刷新重试。'
            : '当前工作区还没有任务。创建任务后，记录与产物会归集到 .dsh/tasks/<任务编号>/。'}
        </p>
      ) : (
        <div className="tl-layout">
          <aside className="tl-sidebar" aria-label="任务列表">
            <div className="tl-controls">
              <input
                type="search"
                aria-label="搜索任务"
                placeholder="搜索任务、标题或分支"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select aria-label="任务状态筛选" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}>
                <option value="open">进行中 / 待归档</option>
                <option value="archived">已归档（{tasks.filter((t) => t.lifecycle === 'archived').length}）</option>
                <option value="all">全部任务</option>
              </select>
              <div className="tl-filter-row">
                <select aria-label="风险筛选" value={risk} onChange={(e) => setRisk(e.target.value)}>
                  <option value="all">全部风险</option>
                  <option value="standard">标准</option>
                  <option value="high_risk">高风险</option>
                </select>
                <select aria-label="阶段筛选" value={stage} onChange={(e) => setStage(e.target.value)}>
                  <option value="all">全部阶段</option>
                  {[...new Set(tasks.map((t) => t.stage))].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <span className="tl-sub tl-small" aria-live="polite">
                匹配 {visible.length} 项{page.cursor ? ' · 仅筛选已载入任务' : ''}
              </span>
            </div>
            <div className="tl-task-list">
              {visible.map((t) => (
                <button
                  key={t.task_id}
                  className="tl-task"
                  type="button"
                  aria-pressed={selected?.task_id === t.task_id}
                  onClick={() => {
                    setSelection({ workspace, id: t.task_id })
                    setExportError('')
                  }}
                >
                  <span className="tl-task-meta">
                    <span>{t.task_id}</span>
                    {pill(
                      lifecycleLabel(t),
                      t.evidence_status === 'failed'
                        ? 'error'
                        : t.requirements && t.requirements.status !== 'confirmed'
                          ? 'warn'
                          : undefined,
                    )}
                  </span>
                  <span className="tl-task-name">{t.title}</span>
                  <span className="tl-task-meta">
                    {t.stage} · {intentLabel(t)}
                  </span>
                </button>
              ))}
            </div>
            {page.cursor && (
              <div className="tl-caption">
                <p>目录共 {page.total} 条记录</p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading || loadingMore}
                  onClick={() => {
                    void loadMore()
                  }}
                >
                  {loadingMore ? '读取中…' : '加载更多'}
                </Button>
              </div>
            )}
          </aside>
          {selected ? (
            <main className="tl-detail" aria-label="任务详情" key={workspace + selected.task_id}>
              <div className="tl-detail-head">
                <div className="tl-row tl-between">
                  <span className="tl-sub tl-small">{selected.task_id}</span>
                  {pill(lifecycleLabel(selected))}
                </div>
                <h2>{selected.title}</h2>
                <div className="tl-row tl-small tl-sub">
                  <span>{intentLabel(selected)}</span>
                  {selected.complexity && (
                    <span>
                      复杂度：
                      {{ low: '低', medium: '中', high: '高', ultra: '超高' }[selected.complexity] ??
                        selected.complexity}
                    </span>
                  )}
                  <span>{selected.risk_level === 'high_risk' ? '高风险' : '标准风险'}</span>
                </div>
                <p className="tl-caption">
                  {selected.branch || '未记录分支'} · 更新于 {time(selected.updated_at)}
                </p>
                <div className="tl-row tl-between" style={{ marginTop: 15 }}>
                  <div className="tl-mode" aria-label="阅读方式">
                    <button type="button" aria-pressed={mode === 'workbench'} onClick={() => setMode('workbench')}>
                      任务工作台
                    </button>
                    <button type="button" aria-pressed={mode === 'document'} onClick={() => setMode('document')}>
                      文档阅读
                    </button>
                  </div>
                  <Button variant="outline" size="sm" onClick={download}>
                    导出 Markdown
                  </Button>
                </div>
              </div>
              {!!selected.evidence_problems?.length && (
                <div className="tl-errors" role="alert">
                  <strong>文件范围或证据无法核验</strong>
                  <ul>{selected.evidence_problems.map((problem, i) => <li key={i}>{problem}</li>)}</ul>
                  <p>{selected.next_action}</p>
                </div>
              )}
              {!!selected.content?.stages.length && (
                <div className="tl-stages" aria-label="任务阶段">
                  {selected.content.stages.map((v, i) => (
                    <span key={v} aria-current={selected.stage === v ? 'step' : undefined}>
                      {i + 1}. {v}
                      {selected.stage === v ? ' · 当前' : ''}
                    </span>
                  ))}
                </div>
              )}
              {mode === 'workbench' && (
                <div className="tl-tabs" role="tablist" aria-label="任务详情栏目">
                  {TABS.map(([id, label], i) => (
                    <button
                      key={id}
                      id={`${tabId}-${id}`}
                      role="tab"
                      className="tl-tab"
                      type="button"
                      aria-selected={tab === id}
                      aria-controls={`${tabId}-panel`}
                      tabIndex={tab === id ? 0 : -1}
                      onKeyDown={(e) => keyboardTab(e, i)}
                      onClick={() => setTab(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <div
                className={'tl-body' + (mode === 'document' ? ' tl-document' : '')}
                {...(mode === 'workbench'
                  ? { role: 'tabpanel', id: `${tabId}-panel`, 'aria-labelledby': `${tabId}-${tab}` }
                  : { role: 'region', 'aria-label': '可读任务文档' })}
              >
                {mode === 'document' ? (
                  <>
                    {requirements(selected)}
                    {plan(selected)}
                    {files(selected)}
                    {verification(selected)}
                  </>
                ) : tab === 'overview' ? (
                  overview(selected, go)
                ) : tab === 'requirements' ? (
                  requirements(selected)
                ) : tab === 'plan' ? (
                  plan(selected)
                ) : tab === 'files' ? (
                  files(selected)
                ) : (
                  verification(selected)
                )}
              </div>
              <div className="tl-provenance">
                只读 · {selected.content?.ledger_path ?? '任务台账'}
                {selected.completed_at && <> · 归档于 {time(selected.completed_at)}</>}
                {selected.related_task && (
                  <>
                    {' '}
                    · 关联 {selected.related_task.kind}：{selected.related_task.id}
                  </>
                )}
              </div>
            </main>
          ) : (
            <div className="tl-empty">没有匹配的任务，请调整搜索或筛选。</div>
          )}
        </div>
      )}
    </div>
  )
}

function overview(t: TaskLedgerEntry, go: (tab: Tab) => void): ReactNode {
  const analysis = t.delivery?.intent === 'analysis',
    r = t.requirements
  return (
    <>
      <div className="tl-next">
        <span className="tl-small tl-sub">{t.lifecycle === 'archived' ? '归档说明' : '下一步'}</span>
        <p>{t.next_action}</p>
      </div>
      <div className="tl-facts">
        <div className="tl-fact">
          <span>需求基线</span>
          {r
            ? pill(
                requirementLabels[r.status] + (r.version ? ` · v${r.version}` : ''),
                r.status === 'confirmed' ? 'good' : 'warn',
              )
            : analysis
              ? '分析范围见交付说明'
              : '尚未记录'}
          {r?.confirmed_at && <p className="tl-caption">确认于 {time(r.confirmed_at)}</p>}
        </div>
        <div className="tl-fact">
          <span>{analysis ? '分析进度' : '实施进度'}</span>
          {analysis ? (t.delivery?.result ? '结论与方案已交付' : '调查中') : `${t.items_done}/${t.items.length} 项完成`}
          {!analysis && t.items.length > 0 && (
            <div
              className="tl-progress"
              role="progressbar"
              aria-label="实施项完成比例"
              aria-valuemin={0}
              aria-valuemax={t.items.length}
              aria-valuenow={t.items_done}
            >
              <span style={{ width: `${(t.items_done / t.items.length) * 100}%` }} />
            </div>
          )}
        </div>
      </div>
      {section(
        '交付材料',
        <>
          <div className="tl-line">
            <div>
              <h4>需求总结与方案</h4>
              <p className="tl-caption">目标、范围、验收条件，以及已记录的架构和编排产物。</p>
            </div>
            <button type="button" className="tl-inline-button" onClick={() => go('requirements')}>
              阅读
            </button>
          </div>
          {!analysis && (
            <div className="tl-line">
              <div>
                <h4>开发方案与实施计划</h4>
                <p className="tl-caption">{t.items.length} 个实施项 · 文件、依赖、验收条件与执行方式。</p>
              </div>
              <button type="button" className="tl-inline-button" onClick={() => go('plan')}>
                阅读
              </button>
            </div>
          )}
        </>,
      )}
      {section(
        '验证与交付',
        analysis ? (
          <p>{t.delivery?.result ? '分析结论及证据已交付；不包含代码实施。' : '尚未提交分析结论。'}</p>
        ) : (
          <>
            <div className="tl-line">
              <span>测试回执</span>
              {pill(
                evidenceLabel(t),
                t.evidence_status === 'valid' ? 'good' : t.evidence_status === 'failed' ? 'error' : 'warn',
              )}
            </div>
            <div className="tl-line">
              <span>代码审核</span>
              {pill(reviewLabel(t), t.review_status === 'valid' ? 'good' : undefined)}
            </div>
            <p className="tl-caption">测试执行结果与业务需求验收分别记录。</p>
          </>
        ),
        <button type="button" className="tl-inline-button" onClick={() => go('verification')}>
          查看详情
        </button>,
      )}
      <details className="tl-evidence">
        <summary>会话、子代理与原始证据</summary>
        <div>{deliveryDetails(t)}</div>
      </details>
    </>
  )
}

function requirements(t: TaskLedgerEntry): ReactNode {
  const r = t.requirements
  return section(
    '需求与方案',
    <>
      {r && (
        <>
          <div className="tl-row">
            {pill(requirementLabels[r.status], r.status === 'confirmed' ? 'good' : 'warn')}
            {r.version && pill(`v${r.version}`)}
            {r.pending_questions > 0 && pill(`${r.pending_questions} 个问题待回答`, 'warn')}
          </div>
          <p className="tl-caption">
            {r.path ?? '尚未生成需求文档'}
            {r.confirmed_at && ` · 确认于 ${time(r.confirmed_at)}`}
          </p>
          {r.feedback && <p className="tl-notice">用户意见：{r.feedback}</p>}
        </>
      )}
      {t.content?.artifacts.length ? (
        t.content.artifacts.map((a) => (
          <section className="tl-section" key={a.id}>
            <div className="tl-section-title" style={{ marginTop: 20 }}>
              <h3>{a.name}</h3>
              {a.stage && <span className="tl-small tl-sub">{a.stage}</span>}
            </div>
            {a.fields.map((f) => (
              <div className="tl-content-block" key={f.key}>
                <h4>{f.label}</h4>
                {markdown(f.value)}
              </div>
            ))}
          </section>
        ))
      ) : r?.content ? (
        markdown(r.content)
      ) : (
        <p className="tl-caption">尚未记录结构化需求或方案产物。</p>
      )}
      {!!r?.materials?.length &&
        section(
          '需求确认材料',
          <>
            <p className="tl-caption">材料及其填写结果用于完善需求，不单独代表需求已批准。</p>
            {r.materials.map((m) => (
              <details className="tl-plan" key={m.path}>
                <summary>
                  {m.name} · v{m.version}
                  {m.retired_at ? ' · 已停用，原文件保留' : ''}
                </summary>
                <div className="tl-plan-body">
                  <code>{m.path}</code>
                  <p className="tl-caption">
                    {m.bytes} 字节 · {time(m.updated_at)}
                  </p>
                  <p className="tl-small tl-sub">文本 SHA-256：{m.hash}</p>
                </div>
              </details>
            ))}
          </>,
        )}
      {t.delivery?.result && <div style={{ marginTop: 20 }}>{deliveryDetails(t)}</div>}
      {r?.content && (
        <details className="tl-evidence">
          <summary>需求总结原文与确认指纹</summary>
          <div>
            {markdown(r.content)}
            <p className="tl-caption">文档 SHA-256：{r.hash ?? '未记录'}</p>
          </div>
        </details>
      )}
    </>,
  )
}

function plan(t: TaskLedgerEntry): ReactNode {
  return section(
    '实施计划',
    t.items.length ? (
      <>
        <p className="tl-caption">
          {t.items_done}/{t.items.length} 项完成。展开查看交付边界和审查记录。
        </p>
        {t.items.map((i) => (
          <details className="tl-plan" key={i.id} open={i.status === 'doing'}>
            <summary>
              <StateDot state={i.status === 'done' ? 'done' : 'ongoing'} />
              {' ' + i.id + ' · ' + i.title + ' '}
              {pill(i.status === 'done' ? '已完成' : i.status === 'doing' ? '进行中' : '待开始')}
            </summary>
            <div className="tl-plan-body">
              {i.execution_plan && (
                <>
                  <div>
                    <h4>登记文件</h4>
                    {i.execution_plan.files.map((f) => (
                      <p key={f}>
                        <code>{f}</code>
                      </p>
                    ))}
                  </div>
                  <div>
                    <h4>验收条件</h4>
                    {markdown(i.execution_plan.acceptance.map((value) => '- ' + value).join('\n'))}
                  </div>
                  {i.execution_plan.boundary && (
                    <div>
                      <h4>实施边界</h4>
                      {
                        { local: '局部修改', independent: '独立工作单元', coupled: '与其他实施项协同' }[
                          i.execution_plan.boundary
                        ]
                      }
                    </div>
                  )}
                </>
              )}
              {itemAudit(i)}
            </div>
          </details>
        ))}
      </>
    ) : (
      <p className="tl-caption">
        {t.delivery?.intent === 'analysis' ? '分析任务不包含代码实施计划。' : '尚未登记实施项；需求确认后按流程编排。'}
      </p>
    ),
  )
}

function files(t: TaskLedgerEntry): ReactNode {
  const registered = registeredFiles(t),
    inputs = t.content?.verification_inputs ?? []
  return (
    <>
      {section(
        '登记文件范围',
        <>
          <p className="tl-caption">这是登记范围和执行计划，不代表实际 Git 变更；是否修改需核对代码差异。</p>
          <div className="tl-files">
            {registered.length ? (
              registered.map((f) => (
                <div className="tl-file" key={f.path}>
                  <code>{f.path}</code>
                  <p className="tl-caption">
                    {f.plannedOnly ? '仅在执行计划中' : '已登记任务范围'} ·{' '}
                    {f.owners.length ? f.owners.join('、') : '未分配实施项'}
                  </p>
                </div>
              ))
            ) : (
              <p className="tl-caption">尚未登记实施文件。</p>
            )}
          </div>
        </>,
      )}
      {section(
        '验证输入',
        inputs.length ? (
          <>
            <p className="tl-caption">测试会读取这些输入；未登记到实施范围的文件，不自动算作本任务修改文件。</p>
            {inputs.map((g) => (
              <details className="tl-plan" key={g.group_id}>
                <summary>
                  {g.group_id} · {g.files.length} 个输入
                </summary>
                <div className="tl-plan-body">
                  {g.files.map((f) => (
                    <div key={f}>
                      <code>{f}</code>
                      <p className="tl-caption">
                        {registered.some((row) => row.path === f) ? '同时属于登记范围' : '验证依赖'}
                      </p>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </>
        ) : (
          <p className="tl-caption">尚未登记测试分组的文件输入。</p>
        ),
      )}
      {t.delivery?.result &&
        section(
          '分析引用的源码',
          <>
            {t.delivery.result.evidence.map((e, index) => (
              <p key={index}>
                <code>
                  {e.file}:{e.start_line}–{e.end_line}
                </code>
              </p>
            ))}
            <p className="tl-caption">这些是分析证据，不代表修改了源码。</p>
          </>,
        )}
    </>
  )
}

function verification(t: TaskLedgerEntry): ReactNode {
  if (t.delivery?.intent === 'analysis')
    return section(
      '分析交付与证据',
      <>
        {deliveryDetails(t)}
        <p className="tl-caption">原因与方案任务不要求代码实施、测试或 Sonar 回执。</p>
      </>,
    )
  return (
    <>
      {section(
        '验证与审核',
        <>
          <div className="tl-row">
            {pill(
              evidenceLabel(t),
              t.evidence_status === 'valid' ? 'good' : t.evidence_status === 'failed' ? 'error' : 'warn',
            )}
            {pill(reviewLabel(t))}
          </div>
          {t.evidence_status === 'stale' && (
            <p className="tl-notice" style={{ marginTop: 14 }}>
              代码或验证输入已变化，旧测试回执不能证明当前版本通过；需要重新验证。
            </p>
          )}
          <p className="tl-caption">回执证明测试程序已执行并产生结果；需求覆盖和验收结论仍需逐项核对。</p>
        </>,
      )}
      {section(
        '测试分组',
        t.verification_groups?.length ? (
          <>
            {t.verification_groups.map((g) => (
              <details key={g.id} className="tl-plan" open={g.status !== 'passed'}>
                <summary>
                  {g.id} ·{' '}
                  {
                    { passed: '通过', failed: '失败', blocked: '环境阻塞', stale: '证据已过期', missing: '待运行' }[
                      g.status
                    ]
                  }
                </summary>
                <div className="tl-plan-body">
                  <p>
                    测试数 {g.test_count ?? '未识别'}
                    {g.checked_at && ` · ${time(g.checked_at)}`}
                  </p>
                  <code>{g.command}</code>
                  {g.problems.map((p) => (
                    <p key={p}>{p}</p>
                  ))}
                </div>
              </details>
            ))}
          </>
        ) : (
          <p className="tl-caption">尚无测试分组记录。</p>
        ),
      )}
      {section('SonarQube 审核', sonarAudit(t) ?? <p className="tl-caption">本任务未启用 SonarQube。</p>)}
      {section(
        '逐项验收',
        t.items.length ? (
          <>
            {t.items.map((i) => (
              <div className="tl-line" key={i.id}>
                <span>
                  {i.id} · {i.title}
                </span>
                <span>
                  {i.review
                    ? `规格：${i.review.spec.outcome === 'pass' ? '通过' : '不通过'} · 质量：${i.review.quality.outcome === 'pass' ? '通过' : '不通过'}`
                    : '尚未记录验收'}
                </span>
              </div>
            ))}
          </>
        ) : (
          <p className="tl-caption">尚未登记实施项。</p>
        ),
      )}
      <details className="tl-evidence">
        <summary>会话与运行证据</summary>
        <div>{deliveryDetails(t)}</div>
      </details>
    </>
  )
}
