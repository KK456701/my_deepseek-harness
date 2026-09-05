/** Evaluation materials are read-only records, never fabricated chat messages. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-experimental-task-contract/types'
import { MessageText } from '@deepseek-ai/dsh-client-ui-primitives'

interface TestRecord {
  seq: number
  test: SessionEventMap['task-review/test-case']
  result?: SessionEventMap['task-review/test-result']
}
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap { 'task-review-test': TestRecord }
}

/** Evaluation identity is explicit; ordinary messages are never classified by their text. */
export const testRecordDefinition: ConversationNodeDefinition<TestRecord> = {
  kind: 'task-review-test', target: 'chat',
  match: event => event.type === 'task-review/test-case' ? { id: event.data.caseId, role: 'start' }
    : event.type === 'task-review/test-result' ? { id: event.data.caseId, role: 'update' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'task-review/test-case') throw new Error('test record requires its metadata')
    return { seq: match.event.seq, test: match.event.data }
  },
  update: (context, match) => match.event.type === 'task-review/test-result' ? { ...context.state, result: match.event.data } : context.state,
  buildViewNode: context => context.state === undefined ? null : {
    key: context.key, id: context.id, kind: context.kind, target: 'chat', anchorSeq: context.state.seq,
    location: context.start?.location ?? { kind: 'session' }, visibility: 'visible', data: context.state,
  },
}

/**
 * Render test materials separately from ordinary conversation history.
 * @param props - Durable test record.
 * @returns Separate materials, expectations and actual outcome.
 */
export function TestRecordRow({ node }: Omit<ChatNodeViewProps<'task-review-test'>, 't'>) {
  const { test, result } = node.data
  const direct = test.kind === 'reviewer'
  return <section aria-label="验收类型" style={{ border: '1px solid #7474c8', padding: 16, borderRadius: 8 }}>
    <h3>{direct ? '【定向筛查】Reviewer' : test.kind === 'full-on' ? '【完整闭环·开启】' : '【完整闭环·关闭】'} · {test.title}</h3>
    <p>{direct ? '固定材料，仅调用 Reviewer，没有 Worker 执行。此记录只读，不可作为普通任务继续。' : '真实对话入口与工具执行；只展示实际发生的辅助调用。'}</p>
    {test.legacy && <p>旧测试记录：此前写入的模拟对话保留供审计，不代表真实 Worker 执行。</p>}
    {test.faultInjection && <p>受控条件／故障注入：{test.faultInjection}</p>}
    <p>验收结论：{result?.status === 'passed' ? '通过' : result === undefined ? '未记录（会话结束不等于验收通过）' : '未通过'}</p>
    {test.materials !== undefined && <details><summary>固定材料：原始要求、计划、证据与候选</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(test.materials, null, 2)}</pre></details>}
    {test.expected !== undefined && <details><summary>期望结果</summary><pre>{JSON.stringify(test.expected, null, 2)}</pre></details>}
    {result !== undefined && <details open>
      <summary>实际结果</summary>
      <MessageText text={result.error ?? JSON.stringify(result.actual, null, 2)} />
    </details>}
    <p>模型输入、原始推理、用量与校验结果请在「轨迹」的「模型调用」行展开查看。</p>
  </section>
}
