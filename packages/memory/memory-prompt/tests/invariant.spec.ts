import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { MemoryGenerationId } from '@deepseek-ai/dsh-memory'
import * as MemoryInvariant from '../src/invariant.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  const session = ctx.sessions.create(SessionId('memory-invariant'))
  const header = session.append('request/header', {
    header: { config: { provider: 'test', model: 'test' }, system: 'Generation: gen-1\nsummary' }, reason: 'initial',
  })
  return { ctx, session, header }
}

describe('memory request observation invariant', () => {
  it('accepts logged observations without adding model messages', async () => {
    const { ctx, session, header } = await setup()
    const before = session.deriveMessages()
    session.append('memory/context', {
      turn: 1, step: 1, headerSeq: header.seq,
      selection: { kind: 'skipped', reason: 'no-generation' },
    }, { ignorable: true })
    const companion = await ctx.plugin(MemoryInvariant)
    expect(session.deriveMessages()).toEqual(before)
    await companion.dispose()
  })

  it('rejects unknown header references when replaying the event stream', async () => {
    const { ctx, session, header } = await setup()
    session.append('memory/context', {
      turn: 1, step: 1, headerSeq: header.seq + 10,
      selection: { kind: 'skipped', reason: 'disabled' },
    }, { ignorable: true })
    await expect(ctx.plugin(MemoryInvariant)).rejects.toThrow(/earlier request\/header/)
  })

  it('rejects required observation envelopes', async () => {
    const { ctx, session, header } = await setup()
    session.append('memory/context', {
      turn: 1, step: 1, headerSeq: header.seq,
      selection: { kind: 'skipped', reason: 'disabled' },
    })
    await expect(ctx.plugin(MemoryInvariant)).rejects.toThrow(/ignorable/)
  })

  it('rejects generation attribution that differs from the actual header', async () => {
    const { ctx, session, header } = await setup()
    session.append('memory/context', {
      turn: 1, step: 1, headerSeq: header.seq,
      selection: {
        kind: 'available', generationId: MemoryGenerationId('gen-other'), summarySha256: 'hash',
        bytes: 7, retainedItems: 1, omittedItems: 0, summaryStart: 18, summaryEnd: 25,
      },
    }, { ignorable: true })
    await expect(ctx.plugin(MemoryInvariant)).rejects.toThrow(/generation must match/)
  })
})
