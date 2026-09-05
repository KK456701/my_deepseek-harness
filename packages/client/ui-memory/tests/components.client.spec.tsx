// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AdHocNote,
  AdHocNoteId,
  MemoryGenerationId,
  MemoryItemId,
  MemoryItemTarget,
  MemoryProfileControlPatch,
  MemoryProfileState,
  MemoryRuntimeSettings,
  MemoryRuntimeSettingsPatch,
  QuarantineRangeId,
  SessionMemoryControls,
  SessionMemoryControlsPatch,
  SubmitAdHocNoteRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { MemoryArea } from '../src/client/MemoryArea.tsx'
import { MemoryControlsAction } from '../src/client/MemoryControlsAction.tsx'
import type { MemoryAreaProps, MemoryAreaSnapshot, MemoryControlsActionProps } from '../src/client/index.ts'
import { en, type MemoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const generationId = 'generation-7' as MemoryGenerationId
const quarantineId = 'range-3' as QuarantineRangeId
const noteId = 'note-2' as AdHocNoteId
const sessionId = 'session-memory' as SessionId

const settings: MemoryRuntimeSettings = {
  extractionBackend: 'llm',
  consolidationBackend: 'llm',
  extractionReasoningEffort: 'high',
  rebuildLookbackMs: 5 * 24 * 60 * 60_000,
  revision: 2,
  idleMs: 6 * 60 * 60_000,
  maxSourceAgeMs: 10 * 24 * 60 * 60_000,
  maxUnusedDays: 30,
  minRemainingQuotaPercent: 25,
  scanSessionsPerRun: 64,
  maxRangesPerRun: 128,
  maxPhase1ClaimsPerRun: 2,
  phase1Concurrency: 2,
  phase1LeaseMs: 60 * 60_000,
  phase2LeaseMs: 20 * 60_000,
  providerTimeoutMs: 10 * 60_000,
  maxAttempts: 3,
  retryBaseMs: 60_000,
  maxCandidatesPerRange: 64,
  maxPhase2Sources: 256,
  maxEvidenceBytes: 512 * 1024,
  maxResultBytes: 2 * 1024 * 1024,
  extractionProvider: 'deepseek-official',
  extractionModel: 'deepseek-v4-flash',
  extractionMaxTokens: 8_192,
  consolidationProvider: 'deepseek-official',
  consolidationModel: 'deepseek-v4-flash',
  consolidationReasoningEffort: 'inherit',
  consolidationMaxTokens: 32_768,
  phase2MaxFileBytes: 2 * 1024 * 1024,
  phase2SearchMaxFiles: 512,
  phase2SearchMaxMatches: 256,
  skillMinSupportingTasks: 2,
  disableOnExternalContext: false,
  externalToolPrefixes: ['web', 'mcp'],
  policyVersion: 2,
  pruneRowsPerRun: 100,
  pruneBytesPerRun: 64 * 1024 * 1024,
  fallbackWakeMs: 15 * 60_000,
  promptSummaryMaxBytes: 32 * 1024,
  recallMaxPasses: 2,
  recallMaxToolCalls: 6,
  recallMaxDetailFiles: 2,
}

const t = ((key: MemoryLocaleKey, params?: Record<string, unknown>): string => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}) as MemoryAreaProps['t']

const snapshot: MemoryAreaSnapshot = {
  sourceUsage: [],
  profile: {
    controlRevision: 1,
    enabled: true,
    useByDefault: true,
    contributeByDefault: true,
    changeSequence: 9,
    currentGenerationId: generationId,
    currentPublishSequence: 7,
    generationStatus: 'ready',
    pendingPhase1: 2,
    pendingPhase2: true,
    quarantineCount: 1,
    totalBytes: 12_288,
  },
  tree: [
    { path: 'memory_summary.md', role: 'summary', bytes: 80, sha256: 'summary-hash' },
    { path: 'MEMORY.md', role: 'catalog', bytes: 96, sha256: 'catalog-hash' },
    { path: 'skills/release/SKILL.md', role: 'skill', bytes: 120, sha256: 'skill-hash' },
    { path: 'rollout_summaries/range-1.md', role: 'rollout', bytes: 72, sha256: 'rollout-hash' },
    { path: 'raw_memories.md', role: 'raw', bytes: 64, sha256: 'raw-hash' },
    { path: 'extensions/ad_hoc/notes/note-2.md', role: 'ad-hoc-note', bytes: 48, sha256: 'note-hash' },
    { path: 'generation-manifest.json', role: 'manifest', bytes: 180, sha256: 'manifest-hash' },
  ],
  items: [{
    id: 'item-1' as MemoryItemId,
    kind: 'preference',
    title: 'Prefer the release checklist',
    content: '- Prefer the release checklist. [source](skills/release/SKILL.md)',
    target: { generationId, path: 'memory_summary.md', startLine: 4, endLine: 4, contentSha256: 'item-hash' },
    sourceIds: ['source:range-1'],
    status: 'active',
    origin: 'automatic',
  }],
  notes: [{
    id: noteId,
    revision: 1,
    action: 'remember',
    processingStatus: 'pending',
    authorityStatus: 'active',
    content: 'Prefer the release checklist.',
    origin: 'ui',
    createdAt: 1,
    updatedAt: 1,
  }],
  quarantines: [{
    id: quarantineId,
    phase: 'phase1',
    reason: 'provider-timeout',
    attempts: 3,
    updatedAt: 2,
  }],
  settings,
}

function properties(overrides: Partial<MemoryAreaProps> = {}): MemoryAreaProps {
  return {
    wide: true,
    t,
    load: vi.fn(async () => snapshot),
    readFile: vi.fn(async () => '# Remembered release method'),
    submitNote: vi.fn(async (request: SubmitAdHocNoteRequest): Promise<AdHocNote> => ({
      id: 'note-new' as AdHocNoteId,
      revision: 1,
      action: request.action,
      processingStatus: 'pending',
      authorityStatus: 'active',
      content: request.content,
      origin: 'ui',
      createdAt: 3,
      updatedAt: 3,
    })),
    rememberMemory: vi.fn(async (content: string): Promise<AdHocNote> => ({
      id: 'note-new' as AdHocNoteId, revision: 1, action: 'remember', processingStatus: 'pending', authorityStatus: 'active',
      content, origin: 'ui', createdAt: 3, updatedAt: 3,
    })),
    updateMemoryItem: vi.fn(async (_target: MemoryItemTarget, content: string): Promise<AdHocNote> => ({
      id: 'note-update' as AdHocNoteId, revision: 1, action: 'update', processingStatus: 'pending', authorityStatus: 'active',
      content, origin: 'ui', createdAt: 3, updatedAt: 3,
    })),
    deleteMemoryItem: vi.fn(async (_target: MemoryItemTarget): Promise<AdHocNote> => ({
      id: 'note-delete' as AdHocNoteId, revision: 1, action: 'forget', processingStatus: 'pending', authorityStatus: 'active',
      content: 'delete', origin: 'ui', createdAt: 3, updatedAt: 3,
    })),
    requestScanAndConsolidation: vi.fn(async () => {}),
    requestConsolidation: vi.fn(async () => {}),
    retryQuarantine: vi.fn(async () => {}),
    saveSettings: vi.fn(async (
      _expectedRevision: number,
      patch: MemoryRuntimeSettingsPatch,
    ) => ({ ...settings, ...patch, revision: settings.revision + 1 })),
    saveProfile: vi.fn(async (
      _expectedRevision: number,
      patch: MemoryProfileControlPatch,
    ): Promise<MemoryProfileState> => ({ ...snapshot.profile, ...patch, controlRevision: 2 })),
    resetMemory: vi.fn(async () => {}),
    startCleanPolicyRebuild: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  } as MemoryAreaProps
}

describe('MemoryArea', () => {
  it('shows distinct source counters, expands extra sources, and keeps card text once', async () => {
    const load = vi.fn(async () => ({ ...snapshot,
      items: [{ ...snapshot.items[0]!,sourceIds: ['source:one','source:two','ad-hoc:note-2'] }],
      sourceUsage: [{ sourceId: 'source:one',adoptedCount: 3,lastAdoptedAt: 1000 }, { sourceId: 'source:two',adoptedCount: 7,lastAdoptedAt: 2000 }, { sourceId: 'ad-hoc:note-2',adoptedCount: 0 }],
    }))
    render(<MemoryArea {...properties({ load })} />)
    fireEvent.click(screen.getByRole('button',{ name: en.trigger }))
    await screen.findByText('GEN 0007')
    expect(screen.getAllByText('Prefer the release checklist. source')).toHaveLength(1)
    expect(screen.getByText('3 recorded citations')).toBeTruthy()
    expect(screen.getByText('7 recorded citations')).toBeTruthy()
    expect(screen.queryByText('10 recorded citations')).toBeNull()
    expect(screen.queryByRole('button',{ name: 'ad-hoc:note-2' })).toBeNull()
    fireEvent.click(screen.getByRole('button',{ name: 'Show 1 more sources' }))
    expect(screen.getByRole('button',{ name: 'ad-hoc:note-2' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button',{ name: 'ad-hoc:note-2' }))
    expect(screen.getByRole('tab',{ name: en.sources }).getAttribute('aria-selected')).toBe('true')
  })

  it('keeps a Task Group heading only as the card title without changing its edit content', async () => {
    const content = '# Task Group: Release\n\nScope: repository\n\n## Task 1: Publish\n\nKeep checks.'
    const load = vi.fn(async () => ({ ...snapshot,items: [{ ...snapshot.items[0]!,kind: 'task-group' as const,title: 'Release',content }] }))
    render(<MemoryArea {...properties({ load })} />)
    fireEvent.click(screen.getByRole('button',{ name: en.trigger }))
    await screen.findByText('GEN 0007')
    expect(screen.getAllByRole('heading',{ name: 'Release' })).toHaveLength(1)
    expect(screen.queryByRole('heading',{ name: 'Task Group: Release' })).toBeNull()
    fireEvent.click(screen.getByRole('button',{ name: en.editMemory }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe(content)
  })
  it('shows original wording separately from the model draft', async () => {
    const conversation: AdHocNote = { ...snapshot.notes[0]!, origin: 'conversation', sourceUserText: 'Remember to use a greeting in replies.', content: 'Always start every reply with a greeting.' }
    const load = vi.fn(async () => ({ ...snapshot, notes: [conversation] }))
    render(<MemoryArea {...properties({ load })} />)
    fireEvent.click(screen.getByRole('button', { name: en.trigger }))
    await screen.findByText('GEN 0007')
    fireEvent.click(screen.getByRole('tab', { name: en.changes }))
    expect(screen.getByText(en.originalUserMessage)).toBeTruthy()
    expect(screen.getByText(conversation.sourceUserText!)).toBeTruthy()
    expect(screen.getByText(en.modelDraft)).toBeTruthy()
    expect(screen.getByText(conversation.content)).toBeTruthy()
  })
  it('confirms the rebuild window and the explicit-note purge independently', async () => {
    const startCleanPolicyRebuild = vi.fn(async () => {})
    render(<MemoryArea {...properties({ startCleanPolicyRebuild })} />)
    fireEvent.click(screen.getByRole('button', { name: en.trigger }))
    await screen.findByText('GEN 0007')
    fireEvent.click(screen.getByRole('button', { name: en.cleanRebuild }))
    expect(startCleanPolicyRebuild).not.toHaveBeenCalled()
    expect(screen.getByText(t('rebuildWindowHint', { days: 5 }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.rebuildPurge }))
    await waitFor(() => { expect(startCleanPolicyRebuild).toHaveBeenCalledWith(432_000_000, 'purge-all') })
  })
  it('stays absent in a narrow Workspace header', () => {
    render(<MemoryArea {...properties({ wide: false })} />)
    expect(screen.queryByRole('button', { name: en.trigger })).toBeNull()
  })

  it('loads semantic cards first and groups formal memory apart from evidence and metadata', async () => {
    const load = vi.fn(async () => snapshot)
    const readFile = vi.fn(async () => '# Remembered release method')
    render(<MemoryArea {...properties({ load, readFile })} />)

    expect(load).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.trigger }))

    expect(await screen.findByText('GEN 0007')).toBeTruthy()
    expect(screen.getByText('12 KB')).toBeTruthy()
    expect(screen.getByRole('tab', { name: en.library }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByText('Prefer the release checklist. source')).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Prefer the release checklist' })).toBeNull()
    expect(readFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: en.sources }))
    await waitFor(() => { expect(readFile).toHaveBeenCalledWith(generationId, 'memory_summary.md') })
    expect(screen.getByText(en.fileGroupFormal)).toBeTruthy()
    expect(screen.getByText(en.fileGroupEvidence)).toBeTruthy()
    expect(screen.getByText(en.fileGroupRequests)).toBeTruthy()
    expect(screen.getByText(en.fileGroupInternal)).toBeTruthy()
    expect(screen.getByText(en.sourceRetentionHint)).toBeTruthy()
    expect(screen.getByText(en.fileCatalog)).toBeTruthy()
    expect(await screen.findByRole('heading', { name: 'Remembered release method' })).toBeTruthy()
  })

  it('adds, edits, and deletes individual memories before retrying quarantines', async () => {
    let notify: (() => void) | undefined
    const load = vi.fn(async () => snapshot)
    const rememberMemory = vi.fn(properties().rememberMemory)
    const updateMemoryItem = vi.fn(properties().updateMemoryItem)
    const deleteMemoryItem = vi.fn(properties().deleteMemoryItem)
    const retryQuarantine = vi.fn(async () => {})
    const subscribe = vi.fn((listener: () => void) => { notify = listener; return () => { notify = undefined } })
    render(<MemoryArea {...properties({ load, rememberMemory, updateMemoryItem, deleteMemoryItem, retryQuarantine, subscribe })} />)
    fireEvent.click(screen.getByRole('button', { name: en.trigger }))
    await screen.findByText('GEN 0007')

    fireEvent.click(screen.getAllByRole('button', { name: en.addMemory }).at(-1)!)
    fireEvent.change(screen.getByRole('textbox', { name: en.memoryContent }), { target: { value: 'Prefer concise release notes.' } })
    fireEvent.click(screen.getAllByRole('button', { name: en.addMemory }).at(-1)!)
    await waitFor(() => { expect(rememberMemory).toHaveBeenCalledWith('Prefer concise release notes.') })
    expect(await screen.findByText(en.explicitRequestSaved)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.editMemory }))
    fireEvent.change(screen.getByRole('textbox', { name: en.memoryContent }), { target: { value: 'Prefer verified release checklists.' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => { expect(updateMemoryItem).toHaveBeenCalledWith(snapshot.items[0]?.target, 'Prefer verified release checklists.') })

    fireEvent.click(screen.getByRole('button', { name: en.deleteMemory }))
    fireEvent.click(screen.getByRole('button', { name: en.confirmDelete }))
    await waitFor(() => { expect(deleteMemoryItem).toHaveBeenCalledWith(snapshot.items[0]?.target) })

    fireEvent.click(screen.getByRole('tab', { name: /Failed tasks/ }))
    fireEvent.click(screen.getByRole('button', { name: en.retryRange }))
    await waitFor(() => { expect(retryQuarantine).toHaveBeenCalledWith(quarantineId) })

    const calls = load.mock.calls.length
    await act(async () => { notify?.() })
    await waitFor(() => { expect(load.mock.calls.length).toBeGreaterThan(calls) })
  })

  it('offers a full manual scan separately from pending-work consolidation', async () => {
    const requestScanAndConsolidation = vi.fn(async () => {})
    const requestConsolidation = vi.fn(async () => {})
    render(<MemoryArea {...properties({ requestScanAndConsolidation, requestConsolidation })} />)
    fireEvent.click(screen.getByRole('button', { name: en.trigger }))
    await screen.findByText('GEN 0007')

    vi.useFakeTimers()
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: en.scanNow }))
        await Promise.resolve()
      })
      expect(requestScanAndConsolidation).toHaveBeenCalledOnce()
      expect(screen.getByText(en.scanRequested)).toBeTruthy()

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: en.consolidatePending }))
        await Promise.resolve()
      })
      expect(requestConsolidation).toHaveBeenCalledOnce()
      expect(screen.getByText(en.consolidationRequested)).toBeTruthy()

      act(() => { vi.advanceTimersByTime(6_000) })
      expect(screen.queryByText(en.consolidationRequested)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps manual scanning available when no Phase 2 work is pending', async () => {
    const requestScanAndConsolidation = vi.fn(async () => {})
    render(<MemoryArea {...properties({
      load: vi.fn(async () => ({ ...snapshot, profile: { ...snapshot.profile, pendingPhase2: false } })),
      requestScanAndConsolidation,
    })} />)
    fireEvent.click(screen.getByRole('button', { name: en.trigger }))
    await screen.findByText('GEN 0007')

    expect(screen.getByRole('button', { name: en.scanNow }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: en.consolidatePending }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.scanNow }))
    await waitFor(() => { expect(requestScanAndConsolidation).toHaveBeenCalledOnce() })
  })

  it('updates the idle threshold without requiring a restart', async () => {
    const saveSettings = vi.fn(async (
      _expectedRevision: number,
      patch: MemoryRuntimeSettingsPatch,
    ): Promise<MemoryRuntimeSettings> => ({ ...settings, ...patch, revision: 3 }))
    render(<MemoryArea {...properties({ saveSettings })} />)
    fireEvent.click(screen.getByRole('button', { name: en.trigger }))
    await screen.findByText('GEN 0007')

    fireEvent.click(screen.getByRole('tab', { name: en.settings }))
    fireEvent.change(screen.getByRole('combobox', { name: en.extractionBackend }), { target: { value: 'codex' } })
    fireEvent.change(screen.getByRole('combobox', { name: en.consolidationBackend }), { target: { value: 'codex' } })
    expect(screen.queryByRole('textbox', { name: en.extractionProvider })).toBeNull()
    expect(screen.queryByRole('textbox', { name: en.consolidationProvider })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: en.extractionModel }), { target: { value: 'test-model' } })
    fireEvent.change(screen.getByRole('textbox', { name: en.consolidationReasoning }), { target: { value: 'max' } })
    const idle = screen.getByRole('spinbutton', { name: en.idleDuration })
    const externalGuard = screen.getByRole('checkbox', { name: en.externalContextGuard }) as HTMLInputElement
    expect(externalGuard.checked).toBe(false)
    fireEvent.click(externalGuard)
    fireEvent.change(idle, { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: en.saveSettings }))

    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith(2, expect.objectContaining({ idleMs: 2 * 60 * 60_000, disableOnExternalContext: true, extractionBackend: 'codex', consolidationBackend: 'codex', extractionModel: 'test-model', consolidationReasoningEffort: 'max' }))
    })
    expect(await screen.findByText(en.settingsSaved)).toBeTruthy()
  })
})

describe('MemoryControlsAction', () => {
  const controls: SessionMemoryControls = { revision: 4, use: 'inherit', contribute: 'allow' }

  function controlProperties(overrides: Partial<MemoryControlsActionProps> = {}): MemoryControlsActionProps {
    return {
      sessionId,
      t,
      loadControls: vi.fn(async () => ({ profile: snapshot.profile, controls })),
      setControls: vi.fn((
        _id: SessionId,
        _revision: number,
        patch: SessionMemoryControlsPatch,
      ): Promise<SessionMemoryControls> => Promise.resolve({ ...controls, ...patch, revision: 5 })),
      ...overrides,
    } as MemoryControlsActionProps
  }

  it('loads inherited profile defaults and commits revisioned Session controls', async () => {
    const setControls = vi.fn((
      _id: SessionId,
      _revision: number,
      patch: SessionMemoryControlsPatch,
    ): Promise<SessionMemoryControls> => Promise.resolve({ ...controls, ...patch, revision: 5 }))
    render(<MemoryControlsAction {...controlProperties({ setControls })} />)

    fireEvent.click(screen.getByRole('button', { name: en.sessionControls }))
    const use = await screen.findByRole('combobox', { name: en.injectControl })
    expect((use as HTMLSelectElement).value).toBe('inherit')
    expect(within(use).getByRole('option', { name: 'Inherit (Allow)' })).toBeTruthy()

    fireEvent.change(use, { target: { value: 'deny' } })
    await waitFor(() => { expect(setControls).toHaveBeenCalledWith(sessionId, 4, { use: 'deny' }) })
    expect((use as HTMLSelectElement).value).toBe('deny')
  })
})
