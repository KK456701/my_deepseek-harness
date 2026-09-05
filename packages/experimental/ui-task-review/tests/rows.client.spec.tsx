// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { InputReceiptRow, ExtractionFailureRow } from '../src/client/Rows.tsx'

afterEach(cleanup)
type ReceiptProps = Parameters<typeof InputReceiptRow>[0]
type FailureProps = Parameters<typeof ExtractionFailureRow>[0]

describe('task admission chat rows', () => {
  it('shows cancelled original input as a receipt rather than an assistant answer', () => {
    const props = { node: { data: { stopped: true, messages: [{ id: 'm', content: [{ type: 'text', text: 'Explain A, B and C.' }] }] } } } as ReceiptProps
    render(<InputReceiptRow {...props} />)
    expect(screen.getByText('Explain A, B and C.')).toBeTruthy()
    expect(screen.getByText(/Worker 接收回执未记录/u)).toBeTruthy()
    expect(screen.queryByText(/未进入 Worker 模型历史/u)).toBeNull()
  })
  it('does not display unknown historical usage as zero or the output cap as actual output', () => {
    const props = { node: { data: { request: { provider: 'official', model: 'flash', maxTokens: 32768 }, result: { error: 'aborted' }, startedAt: 0, endedAt: 180000 } } } as FailureProps
    render(<ExtractionFailureRow {...props} />)
    expect(screen.getByText(/未记录；不能视为 0/u)).toBeTruthy()
    expect(screen.getByText(/不是上下文大小或实际输出量/u)).toBeTruthy()
    expect(screen.getByText(/180.0 秒/u)).toBeTruthy()
  })
  it('separately displays reasoning bytes, reported tokens and a timeout', () => {
    const props = { node: { data: { request: { provider: 'official', model: 'flash', maxTokens: 32768 }, startedAt: 0,
      result: { error: 'aborted', usage: { inputTokens: 10, cacheReadTokens: 5, outputTokens: 200, reasoningTokens: 180 }, response: { durationMs: 180000, termination: 'timeout', textBytes: 50, reasoningBytes: 600, firstOutputMs: 2000, lastOutputMs: 179000, finishReason: 'aborted' } },
    } } } as FailureProps
    render(<ExtractionFailureRow {...props} />)
    expect(screen.getByText(/需求提取超时/u)).toBeTruthy()
    expect(screen.getByText('15 / 200 token')).toBeTruthy()
    expect(screen.getByText('50 / 600 UTF-8 字节（不是 token）')).toBeTruthy()
    expect(screen.getByText('2.0 / 179.0 秒')).toBeTruthy()
  })
})
