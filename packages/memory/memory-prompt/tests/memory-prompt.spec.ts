import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import MemoryService, {
  DEFAULT_MEMORY_RUNTIME_SETTINGS,
  AdHocNoteId,
  MemoryGenerationId,
  MemoryReadLeaseId,
  type AdHocNote,
  type AdHocNoteListRequest,
  type AdHocNotePage,
  type MemoryFileReadRequest,
  type MemoryFileReadResult,
  type MemoryListRequest,
  type MemoryItemListRequest,
  type MemoryItemPage,
  type RememberMemoryRequest,
  type UpdateMemoryItemRequest,
  type DeleteMemoryItemRequest,
  type MemoryProfileControlPatch,
  type MemoryProfileState,
  type MemoryReadRequest,
  type MemorySearchHit,
  type MemorySearchRequest,
  type MemoryRuntimeSettings,
  type MemoryRuntimeSettingsPatch,
  type MemoryPromptSnapshot,
  type MemoryPromptSnapshotResult,
  type MemoryPromptSnapshotRequest,
  type MemoryQuarantineListRequest,
  type MemoryQuarantinePage,
  type MemoryTreePage,
  type MemoryTreeRequest,
  type QuarantineRangeId,
  type ResetMemoryRequest,
  type StartCleanPolicyRebuildRequest,
  type MemoryRebuild,
  type SessionMemoryControls,
  type SessionMemoryControlsPatch,
  type SubmitAdHocNoteRequest,
  type SubmitConversationMemoryRequest,
} from '@deepseek-ai/dsh-memory'
import { CallId, createUserMessage, markAgentLoopRequest, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as memoryPrompt from '../src/index.ts'

class FakeMemory extends MemoryService {
  readonly release = vi.fn<(_id: MemoryReadLeaseId) => Promise<void>>(() => Promise.resolve())
  readonly conversationRequest = vi.fn<(request: SubmitConversationMemoryRequest) => Promise<AdHocNote>>(request => Promise.resolve({
    id: AdHocNoteId('conversation-note'),
    revision: 1,
    action: request.action,
    processingStatus: 'pending',
    authorityStatus: 'active',
    content: request.content,
    origin: 'conversation',
    sourceSessionId: request.sessionId,
    sourceTurn: request.turn,
    sourceUserEventSeq: request.userEventSeq,
    createdAt: 1,
    updatedAt: 1,
  }))
  snapshot: MemoryPromptSnapshot | undefined = {
    kind: 'available', bytes: 24, retainedItems: 1, omittedItems: 0,
    generationId: MemoryGenerationId('generation-1'),
    generationRoot: 'C:\\profile\\memories\\generations\\generation-1',
    summary: '- [Fact](MEMORY.md)',
    summarySha256: 'hash',
    leaseId: MemoryReadLeaseId('lease-1'),
    leaseExpiresAt: Date.now() + 60_000,
  }
  settings: MemoryRuntimeSettings = { revision: 0, ...DEFAULT_MEMORY_RUNTIME_SETTINGS }
  getProfileState(): Promise<MemoryProfileState> { return Promise.reject(new Error('not used')) }
  updateProfileControls(_revision: number, _patch: MemoryProfileControlPatch): Promise<MemoryProfileState> { return Promise.reject(new Error('not used')) }
  getRuntimeSettings(): Promise<MemoryRuntimeSettings> { return Promise.resolve(this.settings) }
  updateRuntimeSettings(_revision: number, _patch: MemoryRuntimeSettingsPatch): Promise<MemoryRuntimeSettings> { return Promise.reject(new Error('not used')) }
  getSessionControls(): Promise<SessionMemoryControls> { return Promise.reject(new Error('not used')) }
  setSessionControls(_id: SessionId, _revision: number, _patch: SessionMemoryControlsPatch): Promise<SessionMemoryControls> { return Promise.reject(new Error('not used')) }
  acquirePromptSnapshot(_request: MemoryPromptSnapshotRequest): Promise<MemoryPromptSnapshotResult> {
    return Promise.resolve(this.snapshot ?? { kind: 'skipped', reason: 'no-generation' })
  }
  releaseReadLease(id: MemoryReadLeaseId): Promise<void> { return this.release(id) }
  listGenerationTree(_request: MemoryTreeRequest): Promise<MemoryTreePage> { return Promise.reject(new Error('not used')) }
  readGenerationFile(_request: MemoryFileReadRequest): Promise<MemoryFileReadResult> { return Promise.reject(new Error('not used')) }
  listMemoryItems(_request: MemoryItemListRequest): Promise<MemoryItemPage> { return Promise.resolve({ items: [], sourceUsage: [] }) }
  rememberMemory(_request: RememberMemoryRequest): Promise<AdHocNote> { return Promise.reject(new Error('not used')) }
  updateMemoryItem(_request: UpdateMemoryItemRequest): Promise<AdHocNote> { return Promise.reject(new Error('not used')) }
  deleteMemoryItem(_request: DeleteMemoryItemRequest): Promise<AdHocNote> { return Promise.reject(new Error('not used')) }
  listMemory(_request: MemoryListRequest): Promise<readonly MemorySearchHit[]> { return Promise.resolve([]) }
  searchMemory(_request: MemorySearchRequest): Promise<readonly MemorySearchHit[]> { return Promise.reject(new Error('not used')) }
  readMemory(_request: MemoryReadRequest): Promise<MemoryFileReadResult> { return Promise.reject(new Error('not used')) }
  listAdHocNotes(_request: AdHocNoteListRequest): Promise<AdHocNotePage> { return Promise.reject(new Error('not used')) }
  submitAdHocNote(_request: SubmitAdHocNoteRequest): Promise<AdHocNote> { return Promise.reject(new Error('not used')) }
  submitConversationMemory(request: SubmitConversationMemoryRequest): Promise<AdHocNote> { return this.conversationRequest(request) }
  requestScanAndConsolidation(): Promise<void> { return Promise.reject(new Error('not used')) }
  requestConsolidation(): Promise<void> { return Promise.reject(new Error('not used')) }
  listQuarantines(_request: MemoryQuarantineListRequest): Promise<MemoryQuarantinePage> { return Promise.reject(new Error('not used')) }
  retryQuarantine(_id: QuarantineRangeId): Promise<void> { return Promise.reject(new Error('not used')) }
  resetMemory(_request: ResetMemoryRequest): Promise<void> { return Promise.reject(new Error('not used')) }
  startCleanPolicyRebuild(_request: StartCleanPolicyRebuildRequest): Promise<MemoryRebuild> { return Promise.reject(new Error('not used')) }
}

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('memory prompt consumer', () => {
  it('records a header-linked observation only at dispatch and flushes it before the downstream call', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(FakeMemory)
    await ctx.plugin(memoryPrompt, { maxSummaryBytes: 1024 })
    const session = ctx.sessions.create(SessionId('dispatch-memory'), { meta: { purpose: 'interactive' } })
    const agent = { id: session.id, session, ctx, options: {}, status: 'idle' } as unknown as Agent
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(session.events.some(event => event.type === 'memory/context')).toBe(false)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const system = assembly.sections.map(section => section.text).join('\n')
    const header = session.append('request/header', { header: { system, config: { provider: 'test', model: 'test' } }, reason: 'initial' })
    const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const downstream = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {
      expect(flush).toHaveBeenCalledWith(session)
      expect(session.events.at(-1)).toMatchObject({ type: 'memory/context', ignorable: true, data: { turn: 1, step: 1, headerSeq: header.seq, selection: { kind: 'available', generationId: 'generation-1' } } })
    })())
    const request = markAgentLoopRequest({ sessionId: session.id, provider: 'test', model: 'test', messages: [], system })
    const auxiliary = vi.fn(() => (async function* (): AsyncIterable<StreamChunk> {})())
    for await (const _chunk of ctx.waterfall('llm/stream', { sessionId: session.id, provider: 'test', model: 'test', messages: [] }, auxiliary)) { /* Auxiliary requests do not carry the Worker marker. */ }
    expect(auxiliary).toHaveBeenCalledOnce()
    expect(session.events.some(event => event.type === 'memory/context')).toBe(false)
    for await (const _chunk of ctx.waterfall('llm/stream', request, downstream)) { /* Empty test provider. */ }
    expect(downstream).toHaveBeenCalledOnce()
    flush.mockRejectedValueOnce(new Error('flush failed'))
    await expect((async () => { for await (const _chunk of ctx.waterfall('llm/stream', request, downstream)) { /* Empty test provider. */ } })()).rejects.toThrow('flush failed')
    expect(downstream).toHaveBeenCalledOnce()
  })

  it('injects the leased summary and releases it at step end', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(FakeMemory)
    await ctx.plugin(memoryPrompt, { maxSummaryBytes: 1024 })
    const session = ctx.sessions.create(SessionId('prompt-session'), { meta: { purpose: 'interactive' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Use the prior memory decision.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const agent = { id: session.id, session, ctx, options: {}, status: 'idle' } as unknown as Agent
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.sections.at(-1)?.text).toContain('<dsh-long-term-memory>')
    expect(assembly.sections.at(-1)?.text).toContain('- [Fact](MEMORY.md)')
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect((ctx.memory as FakeMemory).release).toHaveBeenCalledWith(MemoryReadLeaseId('lease-1')) })
  })

  it('advertises explicit management before the inbox message is logged and authorizes it at execution', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(FakeMemory)
    await ctx.plugin(memoryPrompt, { maxSummaryBytes: 1024 })
    ;(ctx.memory as FakeMemory).snapshot = undefined
    const session = ctx.sessions.create(SessionId('management-only'), { meta: { purpose: 'interactive' } })
    session.append('turn/start', { turn: 1 })
    const agent = { id: session.id, session, ctx, options: {}, status: 'idle' } as unknown as Agent
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.tools.map(tool => tool.name).filter(name => name.startsWith('memory_'))).toEqual(['memory_update_request'])
    expect(assembly.sections.some(section => section.name === 'memory:summary')).toBe(false)
    expect(assembly.sections.find(section => section.name === 'memory:management')?.text).toContain('call memory_update_request before acknowledging persistence')

    const userEvent = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '请忘记之前关于发布偏好的长期记忆。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('memory-forget'),
      name: 'memory_update_request',
      arguments: { action: 'forget', content: '忘记发布偏好', target: '发布偏好' },
      agent,
    })
    expect(result.isError).toBe(false)
    expect((ctx.memory as FakeMemory).conversationRequest).toHaveBeenCalledWith({
      action: 'forget',
      content: '忘记发布偏好',
      target: '发布偏好',
      sessionId: session.id,
      turn: '1',
      userEventSeq: userEvent.seq,
      sourceUserText: userEvent.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
    })
  })

  it('rejects an operation that does not match the current user authorization', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(FakeMemory)
    await ctx.plugin(memoryPrompt, { maxSummaryBytes: 1024 })
    const session = ctx.sessions.create(SessionId('management-action'), { meta: { purpose: 'interactive' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '请记住以后默认使用中文。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const agent = { id: session.id, session, ctx, options: {}, status: 'idle' } as unknown as Agent
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('memory-mismatch'),
      name: 'memory_update_request',
      arguments: { action: 'forget', content: '删除中文偏好' },
      agent,
    })
    expect(result.isError).toBe(true)
    expect((ctx.memory as FakeMemory).conversationRequest).not.toHaveBeenCalled()
  })

  it('accepts an explicit future reply preference in the current turn', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(FakeMemory)
    await ctx.plugin(memoryPrompt, { maxSummaryBytes: 1024 })
    const session = ctx.sessions.create(SessionId('management-remember'), { meta: { purpose: 'interactive' } })
    session.append('turn/start', { turn: 1 })
    const userEvent = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '记住以后回答我的时候加上好的老大。' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const agent = { id: session.id, session, ctx, options: {}, status: 'idle' } as unknown as Agent
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('memory-remember'),
      name: 'memory_update_request',
      arguments: { action: 'remember', content: '以后回答时加上“好的老大”' },
      agent,
    })
    expect(result.isError).toBe(false)
    const text = result.content.find(block => block.type === 'text')
    expect(text?.type === 'text' ? text.text : '').toContain('waiting for a later consolidation')
    expect((ctx.memory as FakeMemory).conversationRequest).toHaveBeenCalledWith({
      action: 'remember',
      content: '以后回答时加上“好的老大”',
      sessionId: session.id,
      turn: '1',
      userEventSeq: userEvent.seq,
      sourceUserText: userEvent.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
    })
  })

  it('enforces live per-turn recall budgets at tool execution', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(FakeMemory)
    await ctx.plugin(memoryPrompt, { maxSummaryBytes: 1024 })
    ;(ctx.memory as FakeMemory).settings = {
      revision: 1,
      ...DEFAULT_MEMORY_RUNTIME_SETTINGS,
      recallMaxPasses: 1,
      recallMaxToolCalls: 2,
    }
    const session = ctx.sessions.create(SessionId('recall-budget'), { meta: { purpose: 'interactive' } })
    session.append('turn/start', { turn: 1 })
    const agent = { id: session.id, session, ctx, options: {}, status: 'idle' } as unknown as Agent
    const first = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('memory-list-1'),
      name: 'memory_list',
      arguments: {},
      agent,
    })
    const second = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('memory-list-2'),
      name: 'memory_list',
      arguments: {},
      agent,
    })
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(true)
    expect(second.content).toEqual([{ type: 'text', text: 'Error: memory recall pass budget is exhausted for this turn' }])
  })

  it('returns a failed tool result instead of acknowledging an unpersisted request', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(FakeMemory)
    await ctx.plugin(memoryPrompt, { maxSummaryBytes: 1024 })
    ;(ctx.memory as FakeMemory).conversationRequest.mockRejectedValueOnce(new Error('memory storage unavailable'))
    const session = ctx.sessions.create(SessionId('failed-save'), { meta: { purpose: 'interactive' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember to keep future status updates brief.' }] }), { surfaceOp: 'append' })
    const agent = { id: session.id, session, ctx, options: {}, status: 'idle' } as unknown as Agent
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('failed-memory-save'), name: 'memory_update_request',
      arguments: { action: 'remember', content: 'Keep future status updates brief.' }, agent,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: memory storage unavailable' }])
  })
})
