/** Browser registration for the Workspace-header profile memory area. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {
  AdHocNote,
  MemoryFileReadResult,
  MemoryGenerationId,
  MemoryItemPage,
  MemoryItemTarget,
  MemoryProfileState,
  MemoryProfileControlPatch,
  MemoryQuarantinePage,
  MemoryRuntimeSettings,
  MemoryRuntimeSettingsPatch,
  MemoryTreePage,
  QuarantineRangeId,
  SessionMemoryControls,
  SessionMemoryControlsPatch,
} from '@deepseek-ai/dsh-api-remotes/client'
import { MemoryArea, type MemoryAreaInjected, type MemoryAreaSnapshot } from './MemoryArea.tsx'
import { MemoryControlsAction, type MemoryControlsInjected } from './MemoryControlsAction.tsx'
import { en, zh, type MemoryLocaleKey } from './locales.ts'

export type { MemoryAreaInjected, MemoryAreaProps, MemoryAreaSnapshot } from './MemoryArea.tsx'
export type { MemoryControlsActionProps, MemoryControlsInjected } from './MemoryControlsAction.tsx'
export type { MemoryLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Profile memory browser and management copy. */
    memory: MemoryLocaleKey
  }
}

const NS = 'memory'

/** Services required by the Workspace action and generated Remote contribution. */
export const inject = ['slots', 'locale', 'remote', 'remote.memory']

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

function unwrap<T>(operation: string, result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error(`${operation} failed: ${result.error.code}: ${result.error.message}`)
}

/** Register the memory action before the Workspace view and add controls. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-memory: dictionaries')
  const listeners = new Set<() => void>()
  ctx.effect(() => ctx.remote.$on('memory/changed', () => {
    for (const listener of [...listeners]) listener()
  }), 'ui-memory: generation changes')
  ctx.effect(() => ctx.remote.$on('memory/runtime-settings-changed', () => {
    for (const listener of [...listeners]) listener()
  }), 'ui-memory: runtime settings changes')

  const profile = async (): Promise<MemoryProfileState> =>
    unwrap('memory.getProfileState', await ctx.remote.memory.getProfileState())

  const tree = async (generationId: MemoryGenerationId): Promise<MemoryTreePage['items']> => {
    const items: MemoryTreePage['items'][number][] = []
    let cursor: string | undefined
    do {
      const page: MemoryTreePage = unwrap('memory.listGenerationTree', await ctx.remote.memory.listGenerationTree({ generationId, limit: 500, ...cursor === undefined ? {} : { cursor } }))
      items.push(...page.items)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return items
  }

  const load: MemoryAreaInjected['load'] = async (): Promise<MemoryAreaSnapshot> => {
    const state = await profile()
    const [files, items, notes, quarantines, settings] = await Promise.all([
      state.currentGenerationId === undefined ? Promise.resolve([]) : tree(state.currentGenerationId),
      ctx.remote.memory.listMemoryItems({ limit: 500 }).then((result): MemoryItemPage => unwrap('memory.listMemoryItems', result)),
      ctx.remote.memory.listAdHocNotes({ limit: 200 }).then(result => unwrap('memory.listAdHocNotes', result)).then(page => page.items),
      ctx.remote.memory.listQuarantines({ limit: 200 }).then((result: RemoteResult<MemoryQuarantinePage>) => unwrap('memory.listQuarantines', result)).then(page => page.items),
      ctx.remote.memory.getRuntimeSettings().then((result: RemoteResult<MemoryRuntimeSettings>) => unwrap('memory.getRuntimeSettings', result)),
    ])
    return { profile: state, tree: files, items: items.items, sourceUsage: items.sourceUsage, notes, quarantines, settings }
  }

  const readFile: MemoryAreaInjected['readFile'] = async (generationId, path) => {
    let offset = 0
    let text = ''
    for (;;) {
      const part: MemoryFileReadResult = unwrap('memory.readGenerationFile', await ctx.remote.memory.readGenerationFile({ generationId, path, offset, maxBytes: 64 * 1024 }))
      text += part.text
      if (part.nextOffset === undefined) return text
      offset = part.nextOffset
    }
  }

  const submitNote: MemoryAreaInjected['submitNote'] = async (request): Promise<AdHocNote> =>
    unwrap('memory.submitAdHocNote', await ctx.remote.memory.submitAdHocNote(request))

  const rememberMemory: MemoryAreaInjected['rememberMemory'] = async (content): Promise<AdHocNote> =>
    unwrap('memory.rememberMemory', await ctx.remote.memory.rememberMemory({ content }))

  const updateMemoryItem: MemoryAreaInjected['updateMemoryItem'] = async (target: MemoryItemTarget, content: string): Promise<AdHocNote> =>
    unwrap('memory.updateMemoryItem', await ctx.remote.memory.updateMemoryItem({ target, content }))

  const deleteMemoryItem: MemoryAreaInjected['deleteMemoryItem'] = async (target: MemoryItemTarget): Promise<AdHocNote> =>
    unwrap('memory.deleteMemoryItem', await ctx.remote.memory.deleteMemoryItem({ target }))

  const requestScanAndConsolidation: MemoryAreaInjected['requestScanAndConsolidation'] = async (): Promise<void> => {
    unwrap('memory.requestScanAndConsolidation', await ctx.remote.memory.requestScanAndConsolidation())
  }

  const requestConsolidation: MemoryAreaInjected['requestConsolidation'] = async (): Promise<void> => {
    unwrap('memory.requestConsolidation', await ctx.remote.memory.requestConsolidation())
  }

  const retryQuarantine: MemoryAreaInjected['retryQuarantine'] = async (id: QuarantineRangeId): Promise<void> => {
    unwrap('memory.retryQuarantine', await ctx.remote.memory.retryQuarantine(id))
  }

  const saveSettings: MemoryAreaInjected['saveSettings'] = async (
    expectedRevision: number,
    patch: MemoryRuntimeSettingsPatch,
  ): Promise<MemoryRuntimeSettings> =>
    unwrap('memory.updateRuntimeSettings', await ctx.remote.memory.updateRuntimeSettings(expectedRevision, patch))

  const saveProfile: MemoryAreaInjected['saveProfile'] = async (
    expectedRevision: number,
    patch: MemoryProfileControlPatch,
  ): Promise<MemoryProfileState> =>
    unwrap('memory.updateProfileControls', await ctx.remote.memory.updateProfileControls(expectedRevision, patch))

  const resetMemory: MemoryAreaInjected['resetMemory'] = async (): Promise<void> => {
    unwrap('memory.resetMemory', await ctx.remote.memory.resetMemory({ confirmation: 'reset-memory' }))
  }

  const startCleanPolicyRebuild: MemoryAreaInjected['startCleanPolicyRebuild'] = async (sourceLookbackMs, explicitNotePolicy): Promise<void> => {
    unwrap('memory.startCleanPolicyRebuild', await ctx.remote.memory.startCleanPolicyRebuild({ confirmation: 'clean-policy-rebuild', sourceLookbackMs, explicitNotePolicy }))
  }

  const injected = (): MemoryAreaInjected => ({
    load,
    readFile,
    submitNote,
    rememberMemory,
    updateMemoryItem,
    deleteMemoryItem,
    requestScanAndConsolidation,
    requestConsolidation,
    retryQuarantine,
    saveSettings,
    saveProfile,
    resetMemory,
    startCleanPolicyRebuild,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })

  ctx.slots.inject('sidebar.workspaces.header.actions', () => ctx.slots.register({
    name: 'sidebar.workspaces.header.actions',
    id: 'memory',
    order: 10,
    locale: NS,
    inject: injected,
  }, MemoryArea))

  const memoryControls = (): MemoryControlsInjected => ({
    loadControls: async (sessionId) => {
      const [profileState, controls] = await Promise.all([
        profile(),
        ctx.remote.memory.getSessionControls(sessionId).then((result: RemoteResult<SessionMemoryControls>) => unwrap('memory.getSessionControls', result)),
      ])
      return { profile: profileState, controls }
    },
    setControls: async (sessionId, expectedRevision, patch: SessionMemoryControlsPatch) =>
      unwrap('memory.setSessionControls', await ctx.remote.memory.setSessionControls(sessionId, expectedRevision, patch)),
  })
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'memory-controls',
    order: 30,
    locale: NS,
    inject: memoryControls,
  }, MemoryControlsAction))
}
