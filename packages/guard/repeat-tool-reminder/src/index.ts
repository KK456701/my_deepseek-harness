/** Deterministic repeated-outcome reminder and pre-dispatch guard. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { isActivePollingResult } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export const name = 'repeat-tool-reminder'
/** Services required by the repeat detector. */
export const inject = ['tools']

/**
 * Plugin config. `include`/`exclude` entries are
 * `*`-wildcard predicates over tool names at call time, not references to
 * registry entries — a pattern matching no currently registered tool is valid
 * (`exclude: [mcp_*]` must stay legal in a deployment that loads no MCP tools).
 */
export interface Config {
  /** Completed identical call/result pairs that trigger a reminder. */
  reminderCount?: number
  /** Attempt number denied before dispatch after an unchanged result run. */
  blockAttempt?: number
  /** Tool-name patterns to track; empty means every tool is tracked. */
  include?: string[]
  /** Tool-name patterns transparent to the chain (neither count nor reset). */
  exclude?: string[]
  /**
   * Maximum characters of canonical arguments quoted in a block diagnostic
   * (default 500). Large payloads (a `write` body, a long command) would
   * otherwise ride into the next request unbounded — precisely in a loop
   * scenario; the cap bounds the reminder, never the detection (the chain key
   * always compares the FULL canonical string).
   */
  argumentsPreviewChars?: number
}

export const Config: z<Config> = z.object({
  reminderCount: z.number().step(1).min(2).default(3),
  blockAttempt: z.number().step(1).min(3).default(4),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  argumentsPreviewChars: z.number().default(500),
})

/**
 * The `{kind:'plugin'}` source stamped on every reminder this guard injects —
 * the label is load-bearing (an unlabeled context would render as a user
 * prompt in derived history).
 */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'repeat-tool-reminder' }

/**
 * Reminder delivered after the configured completed identical outcome count.
 */
function reminderText(count: number): string {
  return `The same tool call has completed with the same result ${count} times. `
    + 'Do not submit it unchanged again. Re-read the latest result, change the '
    + 'approach or arguments, finish with the available evidence, or explain the blocker.'
}

/**
 * Deep key-sort of a parsed-JSON value so two argument objects that differ
 * only in property order canonicalize identically. Arguments reach the guard
 * as the loop's `JSON.parse` output (or its raw-string fallback for malformed
 * argument JSON), so JSON's value domain is the whole input domain — no
 * bigint, cycle, or `undefined` handling exists because no input path can
 * produce them.
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key])
    }
    return sorted
  }
  return value
}

/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue))
}

/** Compile one `*`-wildcard pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** Bound the model-visible argument excerpt without weakening exact detection. */
function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`
}

/** One agent's consecutive identical call/result run. */
interface Chain {
  actionKey: string
  outcomeKey: string
  count: number
  blockedNotice?: boolean
}

const BLOCK_PREFIX = 'Repeated tool call blocked before attempt '

/** Identify this guard's persisted rejection, which is not a new tool outcome.
 * @param content - Model-facing result content, live or persisted.
 * @returns Whether the repeat guard rejected dispatch.
 */
export function isRepeatGuardRejection(content: readonly ContentBlock[]): boolean {
  return content.length === 1 && content[0]?.type === 'text'
    && content[0].text.startsWith(`Error: ${BLOCK_PREFIX}`)
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const reminderCount = config.reminderCount ?? 3
  const blockAttempt = config.blockAttempt ?? 4
  if (!Number.isSafeInteger(reminderCount) || reminderCount < 2) {
    throw new Error('repeat-tool-reminder: reminderCount must be an integer >= 2')
  }
  if (!Number.isSafeInteger(blockAttempt) || blockAttempt !== reminderCount + 1) {
    throw new Error('repeat-tool-reminder: blockAttempt must equal reminderCount + 1')
  }
  const includePatterns = (config.include as string[]).map(wildcardToRegExp)
  const excludePatterns = (config.exclude as string[]).map(wildcardToRegExp)
  const argumentsPreviewChars = config.argumentsPreviewChars as number
  if (!Number.isInteger(argumentsPreviewChars) || argumentsPreviewChars < 1) {
    throw new Error(`repeat-tool-reminder: invalid argumentsPreviewChars ${argumentsPreviewChars} — must be an integer >= 1`)
  }

  const chains = new WeakMap<Agent, Chain | undefined>()

  function chainFor(agent: Agent): Chain | undefined {
    if (chains.has(agent)) return chains.get(agent)
    let chain: Chain | undefined
    const calls = new Map<string, { name: string; arguments: unknown }>()
    for (const event of agent.session.events) {
      if (event.type === 'user/message' && event.data.source.kind === 'user') {
        chain = undefined
        calls.clear()
      } else if (event.type === 'tool/call') {
        let args: unknown
        // Preserve malformed argument text just as the executor does.
        try { args = JSON.parse(event.data.arguments) } catch { args = event.data.arguments }
        calls.set(event.data.callId, { name: event.data.name, arguments: args })
      } else if (event.type === 'tool/result') {
        const call = calls.get(event.data.message.source.callId)
        if (call === undefined || !tracked(call.name)) continue
        const block = event.data.message.content[0]
        if (isActivePollingResult(ctx.tools.get(call.name, agent), call.arguments,
          { isError: block.isError === true, ...(event.data.meta === undefined ? {} : { meta: event.data.meta }) })) continue
        if (block.isError && isRepeatGuardRejection(block.content)) {
          if (chain !== undefined) chain.blockedNotice = true
          continue
        }
        const outcomeKey = canonicalize({ isError: block.isError === true, content: block.content })
        chain = advance(chain, JSON.stringify([call.name, canonicalize(call.arguments)]), outcomeKey)
      }
    }
    chains.set(agent, chain)
    return chain
  }

  /** Whether a tool participates in the chain (untracked calls are transparent: they neither count nor reset). */
  function tracked(toolName: string): boolean {
    if (includePatterns.length > 0 && !includePatterns.some(pattern => pattern.test(toolName))) return false
    return !excludePatterns.some(pattern => pattern.test(toolName))
  }

  ctx.effect(() => ctx.tools.guard((exec) => {
    if (!exec.agent || !tracked(exec.name)) return undefined
    const chain = chainFor(exec.agent)
    const actionKey = JSON.stringify([exec.name, canonicalize(exec.arguments)])
    if (chain === undefined || chain.actionKey !== actionKey || chain.count < reminderCount) return undefined
    const argumentsPreview = previewArguments(canonicalize(exec.arguments), argumentsPreviewChars)
    const reason = `${BLOCK_PREFIX}${blockAttempt}: ${exec.name} ${argumentsPreview}`
    if (!chain.blockedNotice) exec.agent.steer(createUserMessage({
      content: [{ type: 'text', text: `${reason}. Change the approach or explain the blocker.` }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${exec.name} blocked × ${blockAttempt}` },
    }))
    chain.blockedNotice = true
    return reason
  }), 'repeatToolReminder.guard')

  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent || !tracked(exec.name)) return
    if (result.isError && isRepeatGuardRejection(result.content)) return
    if (isActivePollingResult(ctx.tools.get(exec.name, exec.agent), exec.arguments, result)) return
    const actionKey = JSON.stringify([exec.name, canonicalize(exec.arguments)])
    const outcomeKey = canonicalize(outcomeProjection(result))
    const chain = advance(chainFor(exec.agent), actionKey, outcomeKey)
    const { count } = chain
    chains.set(exec.agent, chain)
    if (count !== reminderCount) return
    exec.agent.inject(createUserMessage({
      content: [{ type: 'text', text: reminderText(count) }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: `${exec.name} × ${count}` },
    }))
  })

  // A user interjection changes the context; repetition across it is not a
  // loop. Pure reset hook: always delegates (attaching nothing, vetoing
  // nothing).
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) chains.set(agent, undefined)
    return next()
  })
}

function advance(chain: Chain | undefined, actionKey: string, outcomeKey: string): Chain {
  return chain !== undefined && chain.actionKey === actionKey && chain.outcomeKey === outcomeKey
    ? { ...chain, count: chain.count + 1 }
    : { actionKey, outcomeKey, count: 1 }
}

/** Stable model-facing portion of a settled result. */
function outcomeProjection(result: Readonly<ToolExecutionResult>): unknown {
  return { isError: result.isError, content: result.content }
}
