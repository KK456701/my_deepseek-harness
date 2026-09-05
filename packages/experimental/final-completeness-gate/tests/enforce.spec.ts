import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { describe, expect, it } from 'vitest'
import TaskContractService from '@deepseek-ai/dsh-experimental-task-contract'
import { RequirementId } from '@deepseek-ai/dsh-experimental-task-contract'
import TaskExecutionControl from '@deepseek-ai/dsh-experimental-task-execution-control'
import FinalCompletenessGate from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

function promptText(options: { messages: readonly { content: readonly unknown[] }[] }): string {
  return options.messages.flatMap(message => message.content).flatMap((block) => {
    if (typeof block !== 'object' || block === null || !('type' in block) || !('text' in block)) return []
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('\n')
}

function parserResponse(options: GenerateOptions, requirements: readonly { text: string; quote: string; start: number }[]) {
  const request = JSON.parse(promptText(options)) as { input: { version: number; message: { text: string } } }
  if (request.input.version !== 5) throw new Error('parser request did not use version 5')
  return textResponse(JSON.stringify({ changes: requirements.map(item => ({
    op: 'add', text: item.text, verification: 'answer',
  })) }))
}

function reviewerResponse(options: GenerateOptions) {
  const request = JSON.parse(promptText(options)) as { input: {
    requirements: Array<{ id: string; revision: number; verification: 'answer' | 'execution' }>
    candidateParagraphs: Array<{ id: string; text: string }>
  } }
  return textResponse(JSON.stringify({
    reply: 'complete',
    requirements: request.input.requirements.map(item => ({
      requirementId: item.id, requirementRevision: item.revision, answer: 'covered',
      work: item.verification === 'answer' ? 'not-needed' : 'needs-verification',
      answerEvidence: [{ paragraphId: request.input.candidateParagraphs[0]!.id, quote: request.input.candidateParagraphs[0]!.text }], evidenceEventIds: [], gap: '',
    })),
    missingPlanQuotes: [], unsupportedParagraphIds: [], reason: '逐项覆盖。',
  }))
}

describe('Final Completeness Gate enforce mode', () => {
  it('keeps an unrequested progress summary out of history and continues in the same Turn', async () => {
    const body = '完成整项工作后再回答。'
    let reviewCount = 0
    const adapter = new MockAdapter([
      options => parserResponse(options, [{ text: body, quote: body, start: 0 }]),
      textResponse('本轮先收尾，后续继续。'),
      (options) => {
        reviewCount += 1
        const request = JSON.parse(promptText(options)) as { input: {
          requirements: Array<{ id: string; revision: number; verification: 'answer' | 'execution' }>
          candidateParagraphs: Array<{ id: string; text: string }>
        } }
        return textResponse(JSON.stringify({
          reply: 'continue',
          requirements: request.input.requirements.map(item => ({
            requirementId: item.id,
            requirementRevision: item.revision,
            answer: 'pending-disclosed',
            work: item.verification === 'answer' ? 'not-needed' : 'needs-verification',
            answerEvidence: [{ paragraphId: request.input.candidateParagraphs[0]!.id, quote: request.input.candidateParagraphs[0]!.text }],
            evidenceEventIds: [],
            gap: '用户要求完整交付，当前仅为 Worker 自行结束的进度汇报。',
          })),
          missingPlanQuotes: [],
          unsupportedParagraphIds: [],
          reason: '任务无真实阻塞，应在同一 Turn 继续。',
        }))
      },
      textResponse('整项工作已完成。'),
      (options) => { reviewCount += 1; return reviewerResponse(options) },
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContractService, { mode: 'enforce' })
    await ctx.plugin(TaskExecutionControl, { mode: 'enforce' })
    await ctx.plugin(FinalCompletenessGate, { mode: 'enforce', reviewTiming: 'before-delivery' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('final-gate-unrequested-progress'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(reviewCount).toBe(2)
    const delivered = agent.session.events.filter(event => event.type === 'assistant/message')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.type === 'assistant/message'
      ? delivered[0].data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : '').toBe('整项工作已完成。')
    expect(agent.session.events.filter(event => event.type === 'final-draft/decision').map(event => event.data.status))
      .toEqual(['rejected', 'awaiting_commit', 'committed'])
    expect(new Set(agent.session.events.filter(event => event.type === 'assistant/message').map(event => event.data.turn)))
      .toEqual(new Set([1]))
    await ctx.fiber.dispose()
  })

  it('reviews committed assistant messages and repairs a missing answer in the same Turn', async () => {
    const body = '分别回答 A 和 B。'
    let reviewCount = 0
    const adapter = new MockAdapter([
      options => parserResponse(options, [
        { text: '回答 A。', quote: 'A', start: 3 },
        { text: '回答 B。', quote: 'B', start: 7 },
      ]),
      textResponse('A 已回答。'),
      (options) => {
        reviewCount += 1
        const request = JSON.parse(promptText(options)) as { input: {
          requirements: Array<{ id: string; revision: number }>
          candidateParagraphs: Array<{ id: string; text: string }>
        } }
        return textResponse(JSON.stringify({
          reply: 'interim',
          requirements: request.input.requirements.map((item, index) => ({
            requirementId: item.id, requirementRevision: item.revision,
            answer: index === 0 ? 'covered' : 'missing', work: 'not-needed',
            answerEvidence: index === 0 ? [{ paragraphId: request.input.candidateParagraphs[0]!.id,
              quote: request.input.candidateParagraphs[0]!.text }] : [],
            evidenceEventIds: [], gap: index === 0 ? '' : '缺少 B。',
          })),
          missingPlanQuotes: [], unsupportedParagraphIds: [], reason: 'B 尚未回答。',
        }))
      },
      textResponse('A 已回答；B 也已回答。'),
      (options) => { reviewCount += 1; return reviewerResponse(options) },
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContractService, { mode: 'enforce' })
    await ctx.plugin(TaskExecutionControl, { mode: 'enforce' })
    await ctx.plugin(FinalCompletenessGate, { mode: 'enforce', reviewTiming: 'after-delivery' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('final-gate-after-delivery'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(reviewCount, JSON.stringify(agent.session.events.filter(event => event.type === 'final-review/shadow-result'
      || event.type === 'task-contract/model-assessment' || event.type === 'turn/end'))).toBe(2)
    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'final-draft/chunk')).toHaveLength(0)
    expect(agent.session.events.filter(event => event.type === 'final-review/shadow-result')).toHaveLength(2)
    expect(ctx.taskContract.snapshot(agent.session).requirements.every(item => item.state === 'fulfilled')).toBe(true)
    expect(ctx.taskExecutionControl.snapshot(agent).mode).toBe('running')
    const turns = new Set(agent.session.events.filter(event => event.type === 'assistant/message').map(event => event.data.turn))
    expect(turns).toEqual(new Set([1]))
    const reviewLocations = agent.session.events.flatMap(event => event.type === 'task-contract/model-request'
      && event.data.metadata?.templateId === 'final-candidate-review'
      ? [event.data.metadata.context?.location.phase]
      : [])
    expect(reviewLocations).toEqual(['after-delivery', 'after-delivery'])
    await ctx.fiber.dispose()
  })

  it.each(['complete', 'extra-lookup', 'repair', 'repair-lookup', 'repair-reasoning'] as const)('closes the lookup budget and handles %s without extra evidence dispatch', async (outcome) => {
    const body = '执行检查并报告结果。'
    let evidenceSeq: number | undefined
    let requirementId: string | undefined
    let requirementRevision: number | undefined
    let paragraphId: string | undefined
    let paragraphQuote = ''
    let validResult: string | undefined
    const adapter = new MockAdapter([
      (options) => {
        const request = JSON.parse(promptText(options)) as { input: { message: { text: string } } }
        expect(request.input.message.text).toBe(body)
        return textResponse(JSON.stringify({ changes: [{ op: 'add', text: body, verification: 'execution' }] }))
      },
      (options) => {
        expect(options.tools?.map(tool => tool.name)).not.toContain('session_event_search')
        expect(options.tools?.map(tool => tool.name)).not.toContain('session_event_read')
        return toolCallResponse('inspect-call', 'inspect', {})
      },
      textResponse('检查已经完成。'),
      (options) => {
        const request = JSON.parse(promptText(options)) as { input: {
          evidenceIndex: Array<{ eventId: { seq: number } }>
          requirements: Array<{ id: string; revision: number }>
          candidateParagraphs: Array<{ id: string; text: string }>
        } }
        expect(request.input).not.toHaveProperty('evidence')
        expect(request.input).toHaveProperty('maxEvidenceLookupRounds', 1)
        expect(options.tools?.map(tool => tool.name)).toEqual(['session_event_search', 'session_event_read'])
        evidenceSeq = request.input.evidenceIndex[0]!.eventId.seq
        requirementId = request.input.requirements[0]!.id
        requirementRevision = request.input.requirements[0]!.revision
        paragraphId = request.input.candidateParagraphs[0]!.id
        paragraphQuote = request.input.candidateParagraphs[0]!.text
        return toolCallResponse('read-evidence', 'session_event_read', { seq: evidenceSeq })
      },
      (options) => {
        expect(options.messages.every(message => message.role === 'user')).toBe(true)
        expect(options.messages.flatMap(message => message.content).every(block => block.type === 'text')).toBe(true)
        expect(promptText(options).match(/检查结果：通过/g)).toHaveLength(1)
        expect(promptText(options)).toContain('证据查询预算已用尽')
        expect(options.tools).toBeUndefined()
        if (outcome === 'extra-lookup') return toolCallResponse('forbidden-read', 'session_event_read', { seq: evidenceSeq })
        if (evidenceSeq === undefined || requirementId === undefined || requirementRevision === undefined || paragraphId === undefined) {
          throw new Error('fixture did not capture the frozen review identities')
        }
        validResult = JSON.stringify({
          reply: 'complete',
          requirements: [{
            requirementId, requirementRevision,
            answer: 'covered', work: 'verified', answerEvidence: [{ paragraphId, quote: paragraphQuote }],
            evidenceEventIds: [{ kind: 'local', seq: evidenceSeq }], gap: '',
          }],
          missingPlanQuotes: [], unsupportedParagraphIds: [], reason: '回答和执行证据均已核对。',
        })
        if (outcome === 'repair-reasoning') return [
          { type: 'reasoning-delta', index: 0, text: validResult },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 20 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ]
        return textResponse(outcome.startsWith('repair') ? `Preface\n${validResult}` : validResult)
      },
      ...(outcome.startsWith('repair') ? [(options: GenerateOptions) => {
        expect(options.tools).toBeUndefined()
        expect(promptText(options)).toContain('priorEvidenceLookups')
        expect(promptText(options)).toContain('remainingEvidenceLookupRounds')
        const prior = JSON.parse(options.messages[1]!.content.filter(block => block.type === 'text').map(block => block.text).join('')) as {
          priorEvidenceLookups: Array<{ content: string }>
          remainingEvidenceLookupRounds: number
        }
        expect(prior.priorEvidenceLookups).toHaveLength(1)
        expect(prior.priorEvidenceLookups[0]?.content).toContain('检查结果：通过')
        expect(prior.remainingEvidenceLookupRounds).toBe(0)
        expect(promptText(options)).not.toContain(`Preface\n${validResult}`)
        if (outcome === 'repair-reasoning') {
          expect(promptText(options)).toContain('最终正文为空')
          expect(promptText(options)).not.toContain(validResult)
        }
        if (outcome === 'repair-lookup') return toolCallResponse('repair-forbidden-read', 'session_event_read', { seq: evidenceSeq })
        if (validResult === undefined) throw new Error('missing repair fixture result')
        return textResponse(validResult)
      }] : []),
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContractService, { mode: 'enforce' })
    await ctx.plugin(TaskExecutionControl, { mode: 'enforce' })
    await ctx.plugin(FinalCompletenessGate, { mode: 'enforce', reviewTiming: 'before-delivery', maxEvidenceLookupRounds: 1 })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'inspect', effect: 'read-only', description: 'Run the fixture check.', parameters: {},
      execute: async () => [{ type: 'text', text: '检查结果：通过' }],
    }))
    const agent = ctx.agentLoop.create(SessionId('final-gate-evidence-lookup'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests, JSON.stringify(agent.session.events.slice(-20))).toHaveLength(outcome.startsWith('repair') ? 6 : 5)
    expect(agent.session.events.filter(event => event.type === 'final-review/evidence-access')).toEqual([])
    expect(ctx.taskContract.snapshot(agent.session).requirements[0]?.state).toBe(outcome === 'complete' || outcome === 'repair' || outcome === 'repair-reasoning' ? 'fulfilled' : 'open')
    if (outcome === 'extra-lookup' || outcome === 'repair-lookup') {
      expect(agent.session.events.find(event => event.type === 'turn/end')?.data.reason.kind).toBe('error')
      expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
      expect(agent.session.events.some(event => event.type === 'task-contract/model-assessment'
        && event.data.status === 'failed' && event.data.error?.includes('exceeded 1 evidence lookup rounds'))).toBe(true)
    }
    await ctx.fiber.dispose()
  })

  it('parses independent questions, stages the candidate, and commits it once', async () => {
    const body = 'What is A, and what is B?'
    const adapter = new MockAdapter([
      options => parserResponse(options, [
        { text: 'What is A?', quote: 'What is A', start: 0 },
        { text: 'What is B?', quote: 'what is B?', start: 15 },
      ]),
      textResponse('A is alpha. B is beta.'),
      reviewerResponse,
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContractService, { mode: 'enforce' })
    await ctx.plugin(TaskExecutionControl, { mode: 'enforce' })
    await ctx.plugin(FinalCompletenessGate, { mode: 'enforce', reviewTiming: 'before-delivery' })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('final-gate-enforce'), { provider: 'mock', model: 'mock' })
    agent.session.append('task-review/test-case', { version: 1, kind: 'full-on', caseId: 'normal-dialogue', title: '真实对话' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const eventTypes = agent.session.events.map(event => event.type)
    expect(adapter.requests, JSON.stringify(agent.session.events.slice(-8))).toHaveLength(3)
    expect(eventTypes).toContain('final-draft/chunk')
    expect(eventTypes).not.toContain('assistant/chunk')
    expect(eventTypes.filter(type => type === 'assistant/message')).toHaveLength(1)
    const stagedTextDeltas = agent.session.events.filter(event => event.type === 'final-draft/chunk'
      && event.data.chunk.type === 'text-delta')
    expect(stagedTextDeltas).toHaveLength(1)
    expect(stagedTextDeltas[0]?.type === 'final-draft/chunk' && stagedTextDeltas[0].data.chunk.type === 'text-delta'
      ? stagedTextDeltas[0].data.chunk.text
      : '').toBe('A is alpha. B is beta.')
    const parserRequest = agent.session.events.find(event => event.type === 'task-contract/model-request'
      && event.data.metadata?.templateId === 'requirement-change-parsing')
    expect(parserRequest?.type).toBe('task-contract/model-request')
    if (parserRequest?.type !== 'task-contract/model-request') throw new Error('missing parser audit request')
    const parserChunks = agent.session.events.filter(event => event.type === 'task-contract/model-chunk'
      && event.data.callId === parserRequest.data.callId)
    const parserResponseEvent = agent.session.events.find(event => event.type === 'task-contract/model-response'
      && event.data.callId === parserRequest.data.callId)
    expect(parserChunks.filter(event => event.type === 'task-contract/model-chunk'
      && event.data.chunk.type === 'text-delta').length).toBeLessThan(8)
    expect(parserResponseEvent?.type === 'task-contract/model-response'
      ? parserResponseEvent.data.rawOutput.filter(block => block.type === 'text').map(block => block.text).join('')
      : '').toContain('What is A?')
    expect(agent.session.events.filter(event => event.type === 'final-draft/decision').map(event => event.data.status))
      .toEqual(['awaiting_commit', 'committed'])
    expect(ctx.taskContract.snapshot(agent.session).requirements.map(requirement => requirement.state))
      .toEqual(['fulfilled', 'fulfilled'])
    expect(ctx.tokenMeter.measure(agent.session).baseline.kind).toBe('usage')
    const reviewRequest = agent.session.events.find(event => event.type === 'task-contract/model-request'
      && event.data.metadata?.templateId === 'final-candidate-review')
    expect(reviewRequest?.type === 'task-contract/model-request' && reviewRequest.data.metadata?.context?.location)
      .toMatchObject({ scope: 'conversation', phase: 'before-delivery', turn: 1, step: 1 })
    await ctx.fiber.dispose()
  })

  it('measures the assembled candidate instead of streamed chunk wrappers', async () => {
    const body = '请给出简短回答。'
    const answer = '汉'.repeat(16)
    const maxCandidateBytes = Buffer.byteLength(JSON.stringify([{ type: 'text', text: answer }]))
    const adapter = new MockAdapter([
      options => parserResponse(options, [{ text: body, quote: body, start: 0 }]),
      textResponse(answer),
      reviewerResponse,
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContractService, { mode: 'enforce' })
    await ctx.plugin(TaskExecutionControl, { mode: 'enforce' })
    await ctx.plugin(FinalCompletenessGate, { mode: 'enforce', reviewTiming: 'before-delivery', maxCandidateBytes })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('final-gate-candidate-payload-budget'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(agent.session.events.find(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
    expect(agent.session.events.filter(event => event.type === 'final-draft/decision').map(event => event.data.status))
      .toEqual(['awaiting_commit', 'committed'])
    await ctx.fiber.dispose()
  })

  it('rejects an assembled multibyte candidate above the configured limit', async () => {
    const body = '请给出简短回答。'
    const withinLimit = '汉'.repeat(16)
    const oversized = `${withinLimit}界`
    const maxCandidateBytes = Buffer.byteLength(JSON.stringify([{ type: 'text', text: withinLimit }]))
    const adapter = new MockAdapter([
      options => parserResponse(options, [{ text: body, quote: body, start: 0 }]),
      textResponse(oversized),
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContractService, { mode: 'enforce' })
    await ctx.plugin(TaskExecutionControl, { mode: 'enforce' })
    await ctx.plugin(FinalCompletenessGate, { mode: 'enforce', reviewTiming: 'before-delivery', maxCandidateBytes })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('final-gate-candidate-payload-oversized'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const decision = agent.session.events.find(event => event.type === 'final-draft/decision')
    expect(decision?.type === 'final-draft/decision' ? decision.data : undefined).toMatchObject({
      status: 'aborted',
      reason: `final candidate exceeds ${maxCandidateBytes} UTF-8 bytes`,
    })
    expect(agent.session.events.find(event => event.type === 'turn/end')?.data.reason.kind).toBe('error')
    await ctx.fiber.dispose()
  })

  it('does not hold the turn open while a Shadow review remains in flight', async () => {
    const body = 'answer this'
    const adapter = new MockAdapter([
      options => parserResponse(options, [{ text: 'Answer the question', quote: body, start: 0 }]),
      textResponse('answer'),
      'hang',
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContractService, { mode: 'shadow' })
    await ctx.plugin(TaskExecutionControl, { mode: 'shadow' })
    await ctx.plugin(FinalCompletenessGate, { mode: 'shadow' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('final-gate-shadow'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(agent.status).toBe('idle')
    expect(agent.session.events.some(event => event.type === 'final-review/shadow-start')).toBe(true)
    expect(agent.session.events.some(event => event.type === 'assistant/message')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('delivers a reviewed pause explanation from an execution-control notice', async () => {
    const adapter = new MockAdapter([
      textResponse('工具已暂停；请确认下一步计划。'),
      (options) => {
        const request = JSON.parse(promptText(options)) as { input: {
          requirements: Array<{ id: string; revision: number }>
          candidateParagraphs: Array<{ id: string; text: string }>
        } }
        return textResponse(JSON.stringify({
          reply: 'blocked',
          requirements: request.input.requirements.map(item => ({
            requirementId: item.id,
            requirementRevision: item.revision,
            answer: 'pending-disclosed',
            work: 'needs-verification',
            answerEvidence: [{ paragraphId: request.input.candidateParagraphs[0]!.id, quote: request.input.candidateParagraphs[0]!.text }],
            evidenceEventIds: [],
            gap: '等待用户确认恢复计划。',
          })),
          missingPlanQuotes: [],
          unsupportedParagraphIds: [],
          reason: '如实说明暂停。',
        }))
      },
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContractService, { mode: 'enforce' })
    await ctx.plugin(TaskExecutionControl, { mode: 'enforce' })
    await ctx.plugin(FinalCompletenessGate, { mode: 'enforce', reviewTiming: 'before-delivery' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('final-gate-control-notice'), { provider: 'mock', model: 'mock' })
    const sourceMessage = createUserMessage({ content: [{ type: 'text', text: '执行只读检查。' }], source: { kind: 'user' } })
    const sourceEvent = agent.session.append('user/message', sourceMessage, { surfaceOp: 'append' })
    agent.session.append('task-contract/input', { turn: 0, messages: [{ id: sourceMessage.id, content: sourceMessage.content }] })
    agent.session.append('task-contract/update', {
      formatVersion: 3,
      baseRevision: 0,
      revision: 1,
      sourceMessageIds: [sourceMessage.id],
      updates: [{
        kind: 'add',
        requirement: {
          id: RequirementId('control-notice-requirement'),
          revision: 1,
          text: '执行只读检查。',
          verification: 'execution',
          source: { messageId: sourceMessage.id, start: 0, end: 7, quote: '执行只读检查。', event: { kind: 'local', seq: sourceEvent.seq } },
          state: 'open',
          evidenceEventIds: [],
        },
      }],
    })

    ctx.taskExecutionControl.restrict(agent, 'replanning', '先确认下一步计划。')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'final-draft/decision').map(event => event.data.status))
      .toEqual(['awaiting_commit', 'committed'])
    expect(agent.session.events.find(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
    expect(ctx.taskContract.snapshot(agent.session).requirements[0]?.state).toBe('open')
    await ctx.fiber.dispose()
  })

  it('does not charge tool-call Steps against the final-answer attempt limit', async () => {
    const body = 'Inspect through several read-only steps and then answer.'
    const calls = Array.from({ length: 9 }, (_, index) => toolCallResponse(`read-${index}`, 'read_fixture', { index }))
    const adapter = new MockAdapter([
      options => parserResponse(options, [{ text: body, quote: body, start: 0 }]),
      ...calls,
      textResponse('All nine read-only steps completed.'),
      reviewerResponse,
    ])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TaskContractService, { mode: 'enforce' })
    await ctx.plugin(TaskExecutionControl, { mode: 'enforce' })
    await ctx.plugin(FinalCompletenessGate, { mode: 'enforce', reviewTiming: 'before-delivery', maxCandidatesPerTurn: 1 })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'read_fixture',
      description: 'Return one deterministic read-only fixture.',
      parameters: { index: { type: 'number', required: true } },
      effect: 'read-only',
      execute: async ({ index }) => [{ type: 'text', text: `fixture ${index}` }],
    }))
    const agent = ctx.agentLoop.create(SessionId('final-gate-tool-step-budget'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(agent.session.events.filter(event => event.type === 'final-draft/candidate')).toHaveLength(10)
    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(10)
    expect(agent.session.events.find(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
    await ctx.fiber.dispose()
  })
})
