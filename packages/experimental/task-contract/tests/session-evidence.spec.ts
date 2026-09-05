import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  executeFrozenSessionEvidenceTool, frozenSessionEvidenceIndex,
} from '../src/session-evidence.ts'

function parsedObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected object')
  return parsed as Record<string, unknown>
}

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, time: 1_000 + seq, type, data } as SessionEvent
}

describe('frozen Session evidence lookup', () => {
  it('keeps long results out of locators while preserving exact parameters and bodies on read', () => {
    const body = '完整结果😀'.repeat(2_000)
    const args = JSON.stringify({ file_path: 'F:/测试/😀'.repeat(50), content: 'large write body'.repeat(100) })
    const events = [event(1, 'tool/call', { callId: 'large', name: 'write', arguments: args }),
      event(2, 'tool/result', { message: { source: { callId: 'large' }, content: [{ type: 'tool-result',
        isError: false, content: [{ type: 'text', text: body }] }] } })]
    const index = frozenSessionEvidenceIndex(events[1]!, events)
    expect(Array.from(index.target!)).toHaveLength(120)
    expect(index).not.toHaveProperty('preview')
    expect(index).not.toHaveProperty('contentBytes')
    expect(index).not.toHaveProperty('time')
    expect(JSON.stringify(index)).not.toContain('large write body')
    const read = executeFrozenSessionEvidenceTool(events, 'session_event_read', '{"seq":2}', 4)
    expect(parsedObject(read.content).event).toMatchObject({ content: body, invocation: { arguments: args } })
  })

  it('retains invalid invocation arguments as evidence without guessing a target', () => {
    const call = event(1, 'tool/call', { callId: 'invalid', name: 'read', arguments: '{' })
    expect(frozenSessionEvidenceIndex(call, [call])).not.toHaveProperty('target')
    expect(executeFrozenSessionEvidenceTool([call], 'session_event_read', '{"seq":1}', 4).content).toContain('arguments')
  })

  it('searches and reads only the caller-authorized immutable event set', () => {
    const events = [
      event(2, 'tool/call', { callId: 'a', name: 'read', arguments: '{"path":"a"}' }),
      event(3, 'tool/result', { message: { source: { callId: 'a' }, content: [{ type: 'tool-result', isError: false,
        content: [{ type: 'text', text: 'needle result' }] }] } }),
    ]
    expect(frozenSessionEvidenceIndex(events[1]!, events).success).toBe(true)
    expect(frozenSessionEvidenceIndex(events[1]!, events).invocation).toEqual({ seq: 2, name: 'read' })
    const search = executeFrozenSessionEvidenceTool(events, 'session_event_search', '{"query":"needle"}', 4)
    expect(parsedObject(search.content).matches).toHaveLength(1)
    const read = executeFrozenSessionEvidenceTool(events, 'session_event_read', '{"seq":3}', 4)
    expect(parsedObject(read.content).event).toMatchObject({ eventId: { seq: 3 }, success: true, invocation: { seq: 2, name: 'read' } })
    expect(parsedObject(read.content).event).toMatchObject({ invocation: { arguments: '{"path":"a"}' } })
    const invocation = executeFrozenSessionEvidenceTool(events, 'session_event_read', '{"seq":2}', 4)
    expect(parsedObject(invocation.content).event).toMatchObject({ type: 'tool/call', content: JSON.stringify(events[0]!.data) })
    expect(parsedObject(invocation.content).event).not.toHaveProperty('success')
    expect(() => executeFrozenSessionEvidenceTool(events, 'session_event_read', '{"seq":4}', 4))
      .toThrow(/outside the frozen Session event set/u)
  })

  it('keeps a call distinct from a failed result', () => {
    const call = frozenSessionEvidenceIndex(event(1, 'tool/call', { name: 'inspect', arguments: '{}' }), [])
    const result = frozenSessionEvidenceIndex(event(2, 'tool/result', { message: { content: [{
      type: 'tool-result', isError: true, content: [{ type: 'text', text: 'failed' }],
    }] } }), [])
    expect(call).not.toHaveProperty('success')
    expect(result.success).toBe(false)
  })

  it.each([
    ['pwsh', 'failed test\n[exit code: 1]', {}, false],
    ['bash', 'terminated\n[killed by signal: SIGTERM]', {}, false],
    ['pwsh', 'all tests passed', {}, true],
    ['bash', 'started process', { run_in_background: true }, undefined],
    ['read', 'ordinary file text\n[exit code: 1]', {}, true],
  ])('resolves %s completion from its recorded invocation and result', (name, text, args, success) => {
    const events = [event(1, 'tool/call', { callId: 'process', name, arguments: JSON.stringify(args) }),
      event(2, 'tool/result', { message: { source: { callId: 'process' }, content: [{ type: 'tool-result', isError: false,
        content: [{ type: 'text', text }] }] } })]
    expect(frozenSessionEvidenceIndex(events[1]!, events).success).toBe(success)
    const read = executeFrozenSessionEvidenceTool(events, 'session_event_read', '{"seq":2}', 4)
    expect(parsedObject(read.content).event).toMatchObject({ content: text })
    expect((parsedObject(read.content).event as Record<string, unknown>).success).toBe(success)
  })

  it('does not infer successful completion without a matching earlier call', () => {
    const result = event(2, 'tool/result', { message: { source: { callId: 'missing' }, content: [{ type: 'tool-result',
      isError: false, content: [{ type: 'text', text: 'output' }] }] } })
    const future = event(3, 'tool/call', { callId: 'missing', name: 'read', arguments: '{}' })
    expect(frozenSessionEvidenceIndex(result, [result, future]).success).toBeUndefined()
    expect(frozenSessionEvidenceIndex(result, [result, future]).invocation).toBeUndefined()
  })
})
