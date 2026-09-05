/** Read-only receipt and failure rows; auxiliary responses are not assistant answers. */
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { JsonBlock, MessageText } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from './definitions.ts'
import css from './Rows.module.css'

/**
 * Render direct inputs retained before a Worker step could begin.
 * @param props - Event-derived receipt node.
 * @returns Input content and its explicit admission status.
 */
export function InputReceiptRow({ node }: Omit<ChatNodeViewProps<'task-input-receipt'>, 't'>) {
  return <section className={css.receipt} aria-label="已接收的用户输入">
    <p className={css.status}>{node.data.stopped
      ? '本轮已结束；以下输入的 Worker 接收回执未记录。是否进入模型请核对对应用户消息和实际请求。'
      : '输入已保存，正在预处理；尚未进入 Worker 模型历史。'}</p>
    {node.data.messages.map(message => <div className={css.input} key={message.id}>
      {message.content.map((block, index) => block.type === 'text'
        ? <MessageText key={index} text={block.text} />
        : <JsonBlock key={index} label="输入附件" payload={block} truncatedLabel={total => `共 ${total} 项`} />)}
    </div>)}
  </section>
}

/**
 * Render actual failed-attempt diagnostics without exposing reasoning as a chat response.
 * @param props - Correlated extraction request and terminal audit.
 * @returns Failure, route, elapsed time, reported tokens and received byte counts.
 */
export function ExtractionFailureRow({ node }: Omit<ChatNodeViewProps<'task-extraction-failure'>, 't'>) {
  const { request, result, startedAt, endedAt } = node.data
  const response = result?.response
  const usage = result?.usage
  const duration = response?.durationMs ?? (endedAt === undefined ? undefined : endedAt - startedAt)
  const reason = response?.termination === 'timeout' ? '超时'
    : response?.termination === 'cancelled' ? '已取消' : '失败'
  return <details className={css.failure}>
    <summary>需求提取{reason} · {request.model}{duration === undefined ? '' : ` · ${(duration / 1000).toFixed(1)} 秒`}</summary>
    <p>{result?.error}</p>
    <dl>
      <dt>请求</dt><dd>{request.provider} / {request.model}</dd>
      <dt>最大输出上限</dt><dd>{request.maxTokens.toLocaleString()} token（不是上下文大小或实际输出量）</dd>
      <dt>实际输入 / 输出</dt><dd>{usage === undefined ? '未记录；不能视为 0'
        : `${usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)} / ${usage.outputTokens} token`}</dd>
      <dt>其中推理 token</dt><dd>{usage?.reasoningTokens ?? '提供方未报告'}</dd>
      <dt>收到的正文 / 推理</dt><dd>{response === undefined ? '旧记录未记录'
        : `${response.textBytes} / ${response.reasoningBytes} UTF-8 字节（不是 token）`}</dd>
      <dt>首次 / 最后输出</dt><dd>{response === undefined ? '旧记录未记录'
        : response.firstOutputMs === undefined ? '未收到非空输出'
          : `${(response.firstOutputMs / 1000).toFixed(1)} / ${((response.lastOutputMs ?? response.firstOutputMs) / 1000).toFixed(1)} 秒`}</dd>
      <dt>流结束原因</dt><dd>{response?.finishReason ?? '未记录'}</dd>
    </dl>
    <p className={css.status}>失败响应只保留为审计，不作为正式回答或完成证据。</p>
  </details>
}
