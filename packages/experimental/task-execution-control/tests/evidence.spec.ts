import { describe, expect, it } from 'vitest'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { freezeEvidenceFreshness, mutationWatermark } from '../src/evidence.ts'
import type { ExecutionIncarnation, TaskFileObservation } from '../src/types.ts'

function fixture() {
  const session = Session.create(SessionId('evidence-freshness'))
  const incarnation = 'test' as ExecutionIncarnation
  const start = (id: string, effect: 'unknown' | 'side-effect' | 'read-only' = 'unknown') => {
    const callId = CallId(id)
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
    return session.append('task-execution/dispatch', { callId, rootCallId: callId, incarnation, name: 'bash',
      argumentsJson: '{}', inputRevision: 0, effect, mutationSeq: mutationWatermark(session.events) })
  }
  const end = (id: string, started = true, files?: readonly TaskFileObservation[]) => {
    const callId = CallId(id)
    session.append('task-execution/result', { incarnation, callId, started, isError: false,
      ...(files === undefined ? {} : { files }) })
    return session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: '7/7 tests passed' }] }) }, { surfaceOp: 'append' })
  }
  const classify = () => freezeEvidenceFreshness(session, session.events, undefined, new AbortController().signal)
  return { session, start, end, classify }
}

describe('evidence applicability', () => {
  it('does not confuse a command own outputs with a concurrent modification', async () => {
    const { start, end, classify } = fixture()
    start('test'); const result = end('test')
    expect((await classify())[result.seq]?.status).toBe('current')
  })

  it.each(['after-test', 'during-test', 'already-running'])('invalidates an unscoped test after another mutation: %s', async (position) => {
    const { start, end, classify } = fixture()
    if (position === 'already-running') start('write')
    start('test')
    if (position === 'during-test') start('write')
    const result = end('test')
    if (position === 'after-test') start('write')
    end('write')
    expect((await classify())[result.seq]?.status).toBe('stale')
  })

  it('does not invalidate a test for an operation denied before entering its body', async () => {
    const { session, start, end, classify } = fixture()
    const test = start('test'); const result = end('test')
    start('denied'); end('denied', false)
    expect(mutationWatermark(session.events)).toBe(test.seq)
    expect((await classify())[result.seq]?.status).toBe('current')
  })

  it('preserves unknown outcomes as potentially mutating', async () => {
    const { start, end, classify } = fixture()
    start('test'); const result = end('test')
    start('payment-without-result')
    expect((await classify())[result.seq]?.status).toBe('stale')
  })

  it.each(['changed', 'deleted', 'same'] as const)('compares exact backend file versions: %s', async (state) => {
    const { session, start, end } = fixture()
    const target = { targetKey: FsTargetKey('file-key'), displayPath: 'report.md' }
    start('read', 'read-only')
    const result = end('read', true, [{ target, observation: { kind: 'present', version: FsVersion('v1') } }])
    const fs = { stat: async () => state === 'deleted' ? undefined : { type: 'file' as const, version: FsVersion(state === 'same' ? 'v1' : 'v2') } }
    const evidence = await freezeEvidenceFreshness(session, session.events, fs, new AbortController().signal)
    expect(evidence[result.seq]?.status).toBe(state === 'same' ? 'current' : 'stale')
  })

  it('keeps legacy results readable without fabricating a current-state proof', async () => {
    const { session, classify } = fixture()
    const result = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId: CallId('old'), content: [{ type: 'text', text: 'passed' }], isError: false,
    }) }, { surfaceOp: 'append' })
    expect((await classify())[result.seq]?.status).toBe('unknown')
    expect(session.events).toContain(result)
  })
})
