/** Deterministic model adapter for the Task Contract and Final Gate snapshot. */

import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

const blocked = process.env.DSH_TASK_REVIEW_CASE === 'blocked'

function textFrom(options) {
  return options.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function parsing(prompt) {
  const input = JSON.parse(prompt).input
  const text = input.message?.text
  if (input.version !== 5 || text === undefined) throw new Error('Task Contract snapshot parser received no version 5 message')
  const result = { changes: [
    { op: 'add', text: 'What is A?', verification: blocked ? 'execution' : 'answer' },
    { op: 'add', text: 'What is B?', verification: blocked ? 'execution' : 'answer' },
  ] }
  return JSON.stringify(result)
}

function review(options) {
  const input = JSON.parse(options.messages[0].content.find(block => block.type === 'text').text).input
  if (blocked && (input.version !== 8 || input.evidenceIndex.length !== 1 || input.evidenceIndex[0].success !== false)) {
    throw new Error('Failed Shell completion was not preserved in the frozen review index')
  }
  if (blocked && (options.tools !== undefined || !textFrom(options).includes('证据查询预算已用尽')
    || options.messages.some(message => message.role !== 'user')
    || options.messages.some(message => message.content.some(block => block.type !== 'text'))
    || !textFrom(options).includes('test environment unavailable'))) {
    throw new Error('Closing review must preserve the failed result and remove lookup tools')
  }
  const complete = input.candidateParagraphs.some(paragraph => paragraph.text.includes('B is beta'))
  return JSON.stringify({
    reply: blocked ? 'blocked' : complete ? 'complete' : 'interim',
    requirements: input.requirements.map((item, index) => ({ requirementId: item.id, requirementRevision: item.revision,
      answer: blocked ? 'pending-disclosed' : index === 1 && !complete ? 'missing' : 'covered',
      work: blocked ? 'needs-verification' : 'not-needed',
      answerEvidence: blocked || index === 0 || complete ? [{ paragraphId: input.candidateParagraphs[0].id, quote: input.candidateParagraphs[0].text }] : [], evidenceEventIds: [],
      gap: blocked ? 'The required test environment is unavailable.' : index === 1 && !complete ? 'Answer the second question.' : '' })),
    missingPlanQuotes: [], unsupportedParagraphIds: [],
    reason: blocked ? 'Required execution evidence is unavailable.' : complete ? 'Every answer is covered.' : 'The second answer is missing.',
  })
}

function observation() {
  return JSON.stringify({
    progress: 'uncertain',
    risk: 'none',
    evidenceEventIds: [],
    reason: 'The completed final response is assessed by the separate delivery gate.',
  })
}

function response(options, workerStep) {
  const prompt = textFrom(options)
  if (options.purpose === 'requirement-change-parsing') return parsing(prompt)
  if (options.purpose === 'final-candidate-review' || options.purpose === 'final-shadow-review') return review(options)
  if (options.purpose === 'progress-integrity-observation') return observation()
  if (blocked) return 'Neither A nor B has been verified: the required test environment is unavailable. Both checks remain incomplete.'
  return workerStep === 1 ? 'A is alpha.' : 'A is alpha. B is beta.'
}

class TaskContractSnapshotAdapter extends LlmAdapter {
  parsingAttempts = 0
  workerSteps = 0

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    })
  }

  async * stream(options) {
    if (options.purpose === 'requirement-change-parsing' && this.parsingAttempts++ === 0) {
      yield { type: 'reasoning-delta', index: 0, text: 'checking requirements' }
      yield { type: 'text-delta', index: 1, text: '{"changes":' }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (!options.purpose) this.workerSteps++
    if (blocked && options.purpose === 'final-candidate-review' && options.tools?.length) {
      const input = JSON.parse(options.messages[0].content.find(block => block.type === 'text').text).input
      const id = CallId('snapshot-evidence-read')
      const args = JSON.stringify({ seq: input.evidenceIndex[0].eventId.seq })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'session_event_read', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'session_event_read', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (blocked && !options.purpose && this.workerSteps === 1) {
      const id = CallId('snapshot-failed-test')
      const args = JSON.stringify({ command: 'fixture-test' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'pwsh', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'pwsh', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = response(options, this.workerSteps)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Cordis plugin name. */
export const name = 'task-contract-snapshot-backend'
/** Required LLM registry service. */
export const inject = ['llm', 'tools']

/** Register the deterministic adapter used only by this keyless snapshot. */
export function apply(ctx) {
  // The observer includes durable event timestamps in its audited request.
  // Pin the fixture clock so the exact request is portable without scrubbing it.
  ctx.effect(() => {
    const realNow = Date.now
    Date.now = () => 1_700_000_000_000
    return () => { Date.now = realNow }
  })
  ctx.llm.registerAdapter(['deepseek-official'], new TaskContractSnapshotAdapter())
  if (blocked) ctx.tools.register(defineContentToolFixture({
    name: 'pwsh', description: 'Keyless test-environment failure fixture.', parameters: {}, effect: 'read-only',
    execute: async () => [{ type: 'text', text: 'test environment unavailable\n[exit code: 1]' }],
  }))
}
