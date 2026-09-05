import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type {
  AdHocNote,
  MemoryGenerationFileRole,
  MemoryGenerationId,
  MemoryItem,
  MemoryItemTarget,
  MemorySourceUsage,
  MemoryProfileState,
  MemoryProfileControlPatch,
  MemoryQuarantineItem,
  MemoryRuntimeSettings,
  MemoryRuntimeSettingsPatch,
  MemoryTreeEntry,
  QuarantineRangeId,
  SubmitAdHocNoteRequest,
} from '@deepseek-ai/dsh-api-remotes/client'
import { IconDataOutline16, MarkdownText, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryLocaleKey } from './locales.ts'
import { MemorySettingsPanel } from './MemorySettingsPanel.tsx'
import css from './MemoryArea.module.css'

/** Remote operations and change subscription injected by the browser plugin. */
export interface MemoryAreaInjected {
  /** Read the current state and all bounded management pages. */
  load: () => Promise<MemoryAreaSnapshot>
  /** Read a complete verified generation file through bounded Remote ranges. */
  readFile: (generationId: MemoryGenerationId, path: string) => Promise<string>
  /** Persist a legacy free-form explicit instruction for non-card callers. */
  submitNote: (request: SubmitAdHocNoteRequest) => Promise<AdHocNote>
  /** Persist one explicit new memory. */
  rememberMemory: (content: string) => Promise<AdHocNote>
  /** Persist a revision-safe semantic replacement. */
  updateMemoryItem: (target: MemoryItemTarget, content: string) => Promise<AdHocNote>
  /** Persist a revision-safe semantic deletion. */
  deleteMemoryItem: (target: MemoryItemTarget) => Promise<AdHocNote>
  /** Wake a bounded history scan that bypasses only the idle delay. */
  requestScanAndConsolidation: () => Promise<void>
  /** Wake consolidation for durable pending notes and candidates. */
  requestConsolidation: () => Promise<void>
  /** Requeue one selected quarantined range. */
  retryQuarantine: (id: QuarantineRangeId) => Promise<void>
  /** Persist one optimistic live scheduler-settings update. */
  saveSettings: (expectedRevision: number, patch: MemoryRuntimeSettingsPatch) => Promise<MemoryRuntimeSettings>
  /** Persist live profile enable/use/contribute switches. */
  saveProfile: (expectedRevision: number, patch: MemoryProfileControlPatch) => Promise<MemoryProfileState>
  /** Clear generated memory after a two-step UI confirmation. */
  resetMemory: () => Promise<void>
  /** Delete only derived memory state and relearn every retained eligible Session. */
  startCleanPolicyRebuild: (sourceLookbackMs: number, explicitNotePolicy: 'preserve-active' | 'purge-all') => Promise<void>
  /** Observe committed generation changes received from the Host. */
  subscribe: (listener: () => void) => () => void
}

/** One coherent management snapshot displayed by the dialog. */
export interface MemoryAreaSnapshot {
  readonly profile: MemoryProfileState
  readonly tree: readonly MemoryTreeEntry[]
  readonly items: readonly MemoryItem[]
  readonly sourceUsage: readonly MemorySourceUsage[]
  readonly notes: readonly AdHocNote[]
  readonly quarantines: readonly MemoryQuarantineItem[]
  readonly settings: MemoryRuntimeSettings
}

/** Full slot props for the Workspace header memory action. */
export type MemoryAreaProps = PropsRuntime<'sidebar.workspaces.header.actions'> & PropsLocale<'memory'> & InjectFace<MemoryAreaInjected>

type Tab = 'library' | 'sources' | 'changes' | 'failures' | 'settings'
type ViewState = { readonly status: 'idle' | 'loading' | 'error' } | { readonly status: 'ready'; readonly snapshot: MemoryAreaSnapshot }
type EditorState =
  | { readonly kind: 'add'; readonly content: string }
  | { readonly kind: 'edit'; readonly item: MemoryItem; readonly content: string }
  | { readonly kind: 'delete'; readonly item: MemoryItem }

const ROLE_KEYS = {
  summary: 'fileSummary', catalog: 'fileCatalog', skill: 'fileSkill', rollout: 'fileRollout', raw: 'fileRaw',
  'ad-hoc-note': 'fileNote', manifest: 'fileManifest',
} as const satisfies Record<MemoryGenerationFileRole, MemoryLocaleKey>
const FILE_GROUPS = [
  ['formal', 'fileGroupFormal', ['summary', 'catalog', 'skill']],
  ['evidence', 'fileGroupEvidence', ['rollout', 'raw']],
  ['requests', 'fileGroupRequests', ['ad-hoc-note']],
  ['internal', 'fileGroupInternal', ['manifest']],
] as const satisfies ReadonlyArray<readonly [string, MemoryLocaleKey, readonly MemoryGenerationFileRole[]]>
const ITEM_GROUPS = [
  ['profile', 'groupProfile'], ['preference', 'groupPreference'], ['general-tip', 'groupGeneralTip'], ['task-group', 'groupTaskGroup'],
] as const satisfies ReadonlyArray<readonly [MemoryItem['kind'], MemoryLocaleKey]>
const MAINTENANCE_ACKNOWLEDGEMENT_MS = 6_000

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function shortPath(path: string): string {
  return path.split('/').at(-1) ?? path
}

/** Render the Workspace-header trigger and profile memory management dialog. */
export function MemoryArea(props: MemoryAreaProps): ReactNode {
  const { wide, load, readFile, rememberMemory, updateMemoryItem, deleteMemoryItem, retryQuarantine,
    requestScanAndConsolidation, requestConsolidation, startCleanPolicyRebuild,
    saveSettings, saveProfile, resetMemory, subscribe, t } = props
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('library')
  const [view, setView] = useState<ViewState>({ status: 'idle' })
  const [refresh, setRefresh] = useState(0)
  const [selectedPath, setSelectedPath] = useState<string>()
  const [expandedSources, setExpandedSources] = useState<string[]>([])
  const [fileState, setFileState] = useState<{ status: 'idle' | 'loading' | 'error' } | { status: 'ready'; text: string }>({ status: 'idle' })
  const [editor, setEditor] = useState<EditorState>()
  const [editorStatus, setEditorStatus] = useState<'idle' | 'submitting' | 'error' | 'conflict'>('idle')
  const [requestSaved, setRequestSaved] = useState(false)
  const [retrying, setRetrying] = useState<QuarantineRangeId>()
  const [maintenanceStatus, setMaintenanceStatus] = useState<
    'idle' | 'scan-requesting' | 'scan-requested' | 'consolidation-requesting' | 'consolidation-requested' | 'rebuild-armed' | 'rebuild-requesting' | 'error'
  >('idle')

  useEffect(() => subscribe(() => {
    setRequestSaved(false)
    setRefresh(value => value + 1)
    setMaintenanceStatus(status => status === 'scan-requested' || status === 'consolidation-requested' ? 'idle' : status)
  }), [subscribe])
  useEffect(() => {
    if (maintenanceStatus !== 'scan-requested' && maintenanceStatus !== 'consolidation-requested') return
    const timeoutId = window.setTimeout(() => { setMaintenanceStatus('idle') }, MAINTENANCE_ACKNOWLEDGEMENT_MS)
    return () => { window.clearTimeout(timeoutId) }
  }, [maintenanceStatus])
  useEffect(() => {
    if (!open) return
    let current = true
    setView({ status: 'loading' })
    void load().then((snapshot) => {
      if (!current) return
      setView({ status: 'ready', snapshot })
      const fallback = snapshot.tree.find(file => file.role === 'summary')?.path ?? snapshot.tree[0]?.path
      setSelectedPath(path => path !== undefined && snapshot.tree.some(file => file.path === path) ? path : fallback)
    }, () => { if (current) setView({ status: 'error' }) })
    return () => { current = false }
  }, [load, open, refresh])

  const generationId = view.status === 'ready' ? view.snapshot.profile.currentGenerationId : undefined
  useEffect(() => {
    if (!open || generationId === undefined || selectedPath === undefined || tab !== 'sources') {
      setFileState({ status: 'idle' })
      return
    }
    let current = true
    setFileState({ status: 'loading' })
    void readFile(generationId, selectedPath).then(
      (text) => { if (current) setFileState({ status: 'ready', text }) },
      () => { if (current) setFileState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [generationId, open, readFile, selectedPath, tab])

  const groupedFiles = useMemo(() => view.status !== 'ready' ? [] : FILE_GROUPS
    .map(([id, label, roles]) => ({ id, label, items: view.snapshot.tree.filter(file => roles.some(role => role === file.role)) }))
    .filter(group => group.items.length > 0), [view])

  const submitEditor = (event: FormEvent): void => {
    event.preventDefault()
    if (editor === undefined || editorStatus === 'submitting') return
    const operation = editor.kind === 'add'
      ? rememberMemory(editor.content.trim())
      : editor.kind === 'edit'
        ? updateMemoryItem(editor.item.target, editor.content.trim())
        : deleteMemoryItem(editor.item.target)
    setEditorStatus('submitting')
    setRequestSaved(false)
    void operation.then(() => {
      setEditor(undefined)
      setEditorStatus('idle')
      setRequestSaved(true)
      setRefresh(value => value + 1)
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message.toLocaleLowerCase() : ''
      setEditorStatus(message.includes('conflict') ? 'conflict' : 'error')
    })
  }

  const retryRange = (id: QuarantineRangeId): void => {
    if (retrying !== undefined) return
    setRetrying(id)
    void retryQuarantine(id).then(
      () => { setRetrying(undefined); setRefresh(value => value + 1) },
      () => { setRetrying(undefined) },
    )
  }

  const consolidateNow = (): void => {
    if (maintenanceStatus === 'scan-requesting' || maintenanceStatus === 'consolidation-requesting') return
    setMaintenanceStatus('consolidation-requesting')
    void requestConsolidation().then(
      () => { setMaintenanceStatus('consolidation-requested'); setRefresh(value => value + 1) },
      () => { setMaintenanceStatus('error') },
    )
  }

  const scanNow = (): void => {
    if (maintenanceStatus === 'scan-requesting' || maintenanceStatus === 'consolidation-requesting') return
    setMaintenanceStatus('scan-requesting')
    void requestScanAndConsolidation().then(
      () => { setMaintenanceStatus('scan-requested'); setRefresh(value => value + 1) },
      () => { setMaintenanceStatus('error') },
    )
  }

  const cleanRebuild = (): void => {
    setMaintenanceStatus('rebuild-armed')
  }

  const confirmRebuild = (purgeNotes: boolean): void => {
    if (view.status !== 'ready') return
    setMaintenanceStatus('rebuild-requesting')
    void startCleanPolicyRebuild(view.snapshot.settings.rebuildLookbackMs, purgeNotes ? 'purge-all' : 'preserve-active').then(
      () => { setMaintenanceStatus('idle'); setRefresh(value => value + 1) },
      () => { setMaintenanceStatus('error') },
    )
  }

  if (!wide) return null
  const snapshot = view.status === 'ready' ? view.snapshot : undefined
  const sequence = snapshot?.profile.currentPublishSequence

  return <>
    <Modal open={maintenanceStatus === 'rebuild-armed'} onClose={() => { setMaintenanceStatus('idle') }} title={t('cleanRebuild')} closeLabel={t('cancel')}>
      <p>{t('rebuildWindowHint', { days: (snapshot?.settings.rebuildLookbackMs ?? 0) / 86_400_000 })}</p>
      <div className={css.toolbarActions}>
        <button type="button" onClick={() => { confirmRebuild(false) }}>{t('rebuildPreserve')}</button>
        <button type="button" className={css.dangerButton} onClick={() => { confirmRebuild(true) }}>{t('rebuildPurge')}</button>
      </div>
    </Modal>
    <Tooltip label={t('trigger')} side="bottom" delayMs={500}>
      <button type="button" className={css.trigger} aria-label={t('trigger')} aria-expanded={open} onClick={() => { setOpen(true) }}>
        <IconDataOutline16 size={16} />
        {snapshot?.profile.pendingPhase2 === true ? <span className={css.pendingDot} aria-hidden="true" /> : null}
      </button>
    </Tooltip>
    <Modal open={open} onClose={() => { setOpen(false) }} title={t('title')} closeLabel={t('close')}
      description={t('description')} className={css.dialog ?? ''} contentClassName={css.modalContent ?? ''}>
      {view.status === 'loading' || view.status === 'idle' ? <p className={css.message}>{t('loading')}</p> : null}
      {view.status === 'error' ? <div className={css.failure} role="alert"><p>{t('unavailable')}</p><button type="button" onClick={() => { setRefresh(value => value + 1) }}>{t('retry')}</button></div> : null}
      {snapshot !== undefined ? <div className={css.surface}>
        <div className={css.ledgerBar}>
          <div className={css.generationSeal}><span className={css.liveDot} aria-hidden="true" /><span>{sequence === undefined ? 'GEN —' : t('sequence', { sequence: String(sequence).padStart(4, '0') })}</span></div>
          <dl className={css.stats}>
            <div><dt>{t('storage')}</dt><dd>{formatBytes(snapshot.profile.totalBytes)}</dd></div>
            <div><dt>{t('extracting')}</dt><dd>{snapshot.profile.pendingPhase1}</dd></div>
            <div><dt>{t('quarantine')}</dt><dd>{snapshot.profile.quarantineCount}</dd></div>
            <div><dt>{t('generation')}</dt><dd>{snapshot.profile.pendingPhase2 ? t('waiting') : t('healthy')}</dd></div>
          </dl>
        </div>
        {!snapshot.profile.enabled ? <p className={css.notice}>{t('disabled')}</p> : null}
        {snapshot.profile.generationStatus === 'rebuild-required' ? <p className={css.legacyNotice}>{t('rebuildRequired')}</p> : null}
        {snapshot.profile.rebuild !== undefined && snapshot.profile.rebuild.status !== 'published' && snapshot.profile.rebuild.status !== 'cancelled' ? <div className={css.legacyNotice} role="status">
          <strong>{t('cleanRebuildRunning')}</strong> {t('cleanRebuildProgress', { status: snapshot.profile.rebuild.status, scanned: snapshot.profile.rebuild.scannedSessions, total: snapshot.profile.rebuild.totalSessions, extracted: snapshot.profile.rebuild.extractedSessions, empty: snapshot.profile.rebuild.emptySessions, failed: snapshot.profile.rebuild.failedSessions })}
        </div> : null}
        <div className={css.tabs} role="tablist" aria-label={t('title')}>
          {(['library', 'sources', 'changes', 'failures', 'settings'] as const).map(id => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id) }}>
            {t(id)}{id === 'failures' && snapshot.quarantines.length > 0 ? <span>{snapshot.quarantines.length}</span> : null}
          </button>)}
        </div>

        {tab === 'library' ? <div className={css.itemsView}>
          <div className={css.itemsToolbar}><div><strong>{t('library')}</strong><small>{snapshot.items.length}</small></div><div className={css.toolbarActions}><span aria-live="polite">{maintenanceStatus === 'scan-requested' ? t('scanRequested') : maintenanceStatus === 'consolidation-requested' ? t('consolidationRequested') : maintenanceStatus === 'error' ? t('maintenanceFailed') : null}</span><button type="button" className={css.secondaryAction} disabled={!snapshot.profile.enabled || maintenanceStatus === 'scan-requesting' || maintenanceStatus === 'consolidation-requesting' || maintenanceStatus === 'rebuild-requesting'} onClick={scanNow}>{maintenanceStatus === 'scan-requesting' ? t('scanningNow') : t('scanNow')}</button><button type="button" className={css.secondaryAction} disabled={!snapshot.profile.enabled || !snapshot.profile.pendingPhase2 || maintenanceStatus === 'scan-requesting' || maintenanceStatus === 'consolidation-requesting' || maintenanceStatus === 'rebuild-requesting'} onClick={consolidateNow}>{maintenanceStatus === 'consolidation-requesting' ? t('consolidatingNow') : t('consolidatePending')}</button><button type="button" className={css.secondaryAction} disabled={!snapshot.profile.enabled || maintenanceStatus === 'rebuild-requesting'} onClick={cleanRebuild}>{maintenanceStatus === 'rebuild-armed' ? t('cleanRebuildConfirm') : maintenanceStatus === 'rebuild-requesting' ? t('cleanRebuildStarting') : t('cleanRebuild')}</button><button type="button" onClick={() => { setEditor({ kind: 'add', content: '' }); setEditorStatus('idle') }}>{t('addMemory')}</button></div></div>
          {snapshot.items.length === 0 ? <p className={css.message}>{t('itemEmpty')}</p> : ITEM_GROUPS.map(([kind, label]) => {
            const items = snapshot.items.filter(item => item.kind === kind)
            return items.length === 0
              ? null
              : <section className={css.itemGroup} key={kind}>
                <h3>{t(label)}<span>{items.length}</span></h3>
                <div className={css.itemGrid}>{items.map(item => <article
                  className={css.memoryCard}
                  data-status={item.status}
                  key={item.id}
                >
                  <header><div><span className={css.originTag}>{t(item.origin === 'explicit' ? 'explicitSource' : item.origin === 'mixed' ? 'mixedSource' : 'automaticSource')}</span><span className={css.statusTag}>{t(item.status === 'pending-update' ? 'pendingUpdateStatus' : item.status === 'pending-delete' ? 'pendingDeleteStatus' : 'activeStatus')}</span></div><nav aria-label={item.title}><button type="button" disabled={item.status !== 'active'} onClick={() => { setEditor({ kind: 'edit', item, content: item.content }); setEditorStatus('idle') }}>{t('editMemory')}</button><button type="button" disabled={item.status !== 'active'} onClick={() => { setEditor({ kind: 'delete', item }); setEditorStatus('idle') }}>{t('deleteMemory')}</button></nav></header>
                  {item.kind === 'task-group' ? <h4>{item.title}</h4> : null}
                  <div className={css.cardContent}><MarkdownText text={item.kind === 'task-group' ? item.content.replace(/^#{1,6}[^\r\n]*(?:\r?\n|$)/u, '') : item.content} /></div>
                  <footer><span>{t('sourceCount', { count: item.sourceIds.length })}</span><code>{item.target.path}#L{item.target.startLine}</code></footer>
                  <section className={css.sourceUsage} aria-label={t('sourceUsage')}>
                    <strong>{t('sourceUsage')}</strong>
                    {item.sourceIds.map((sourceId, index) => {
                      const usage = snapshot.sourceUsage.find(value => value.sourceId === sourceId)
                      const path = sourceId.startsWith('source:') ? `rollout_summaries/${sourceId.slice(7)}.md`
                        : `extensions/ad_hoc/notes/${sourceId.replace(/^ad-hoc:/u, '')}.md`
                      return <div key={sourceId} hidden={index >= 2 && !expandedSources.includes(item.id)}>
                        <button type="button" title={sourceId} onClick={() => { setSelectedPath(path); setTab('sources') }}>{sourceId}</button>
                        <span>{usage === undefined || usage.adoptedCount === 0 ? t('sourceUnused') : t('sourceCitations', { count: usage.adoptedCount })}</span>
                        {usage?.lastAdoptedAt === undefined ? null : <time dateTime={new Date(usage.lastAdoptedAt).toISOString()}>{t('sourceLastUsed')}: {new Date(usage.lastAdoptedAt).toLocaleString()}</time>}
                      </div>
                    })}
                    {item.sourceIds.length > 2 ? <button type="button" aria-expanded={expandedSources.includes(item.id)} onClick={() => { setExpandedSources(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id]) }}>{t(expandedSources.includes(item.id) ? 'sourceCollapse' : 'sourceExpand', { count: item.sourceIds.length - 2 })}</button> : null}
                    <small>{t('sourceUsageHint')}</small>
                  </section>
                </article>)}</div>
              </section>
          })}
        </div> : null}

        {tab === 'sources' ? snapshot.profile.currentGenerationId === undefined ? <p className={css.message}>{t('empty')}</p> : <div className={css.sourcePane}>
          <p className={css.sourceHint}>{t('sourceRetentionHint')}</p>
          <div className={css.library}>
            <nav className={css.tree} aria-label={t('sources')}>{groupedFiles.map(group => group.id === 'internal' ? <details className={css.fileGroup} key={group.id}><summary>{t(group.label)}<span>{group.items.length}</span></summary><div>{group.items.map(file => <button key={file.path} type="button" className={selectedPath === file.path ? css.fileSelected : undefined} title={file.path} onClick={() => { setSelectedPath(file.path) }}><span><strong>{shortPath(file.path)}</strong><em>{t(ROLE_KEYS[file.role])}</em></span><small>{formatBytes(file.bytes)}</small></button>)}</div></details> : <section className={css.fileGroup} key={group.id}><h3>{t(group.label)}<span>{group.items.length}</span></h3>{group.items.map(file => <button key={file.path} type="button" className={selectedPath === file.path ? css.fileSelected : undefined} title={file.path} onClick={() => { setSelectedPath(file.path) }}><span><strong>{shortPath(file.path)}</strong><em>{t(ROLE_KEYS[file.role])}</em></span><small>{formatBytes(file.bytes)}</small></button>)}</section>)}</nav>
            <article className={css.document} aria-live="polite"><header><code>{selectedPath}</code></header>{fileState.status === 'idle' ? <p>{t('selectFile')}</p> : null}{fileState.status === 'loading' ? <p>{t('reading')}</p> : null}{fileState.status === 'error' ? <p role="alert">{t('readFailed')}</p> : null}{fileState.status === 'ready' ? <MarkdownText text={fileState.text} /> : null}</article>
          </div>
        </div> : null}

        {requestSaved ? <p role="status">{t('explicitRequestSaved')}</p> : null}
        {tab === 'changes' ? snapshot.notes.length === 0 ? <p className={css.message}>{t('requestEmpty')}</p> : <ol className={css.noteList}>{snapshot.notes.map(item => <li key={item.id}><span data-status={item.processingStatus}>{t(item.action === 'remember' ? 'rememberAction' : item.action === 'update' ? 'updateAction' : 'forgetAction')} · {t(item.processingStatus === 'pending' ? 'notePending' : item.processingStatus === 'claimed' ? 'noteClaimed' : item.processingStatus === 'applied' ? 'noteApplied' : item.processingStatus === 'partial' ? 'notePartial' : item.processingStatus === 'unresolved' ? 'noteUnresolved' : 'noteFailed')} · {t(item.authorityStatus === 'active' ? 'noteActive' : item.authorityStatus === 'superseded' ? 'noteSuperseded' : 'noteCleared')}</span>{item.origin === 'conversation' ? <><strong>{t('originalUserMessage')}</strong><p>{item.sourceUserText ?? t('originalUnavailable')}</p><strong>{t('modelDraft')}</strong></> : null}<p>{item.content}</p></li>)}</ol> : null}
        {tab === 'failures' ? snapshot.quarantines.length === 0 ? <p className={css.message}>{t('quarantineEmpty')}</p> : <ul className={css.quarantineList}>{snapshot.quarantines.map(item => <li key={item.id}><div><strong>{t(item.phase)}</strong><code>{item.id}</code><p>{item.reason}</p><small>{t('attempts')}: {item.attempts}</small></div><button type="button" disabled={retrying !== undefined} onClick={() => { retryRange(item.id) }}>{retrying === item.id ? t('retrying') : t('retryRange')}</button></li>)}</ul> : null}
        {tab === 'settings' ? <MemorySettingsPanel profile={snapshot.profile} saveProfile={async (revision, patch) => { const committed = await saveProfile(revision, patch); setRefresh(value => value + 1); return committed }} settings={snapshot.settings} save={async (revision, patch) => { const committed = await saveSettings(revision, patch); setRefresh(value => value + 1); return committed }} reset={async () => { await resetMemory(); setRefresh(value => value + 1) }} t={t} /> : null}
      </div> : null}

      {editor !== undefined ? <div className={css.editorBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && editorStatus !== 'submitting') setEditor(undefined) }}>
        <form className={css.editorDialog} onSubmit={submitEditor} onKeyDown={(event) => { if (event.key === 'Escape' && editorStatus !== 'submitting') { event.stopPropagation(); setEditor(undefined) } }} role="dialog" aria-modal="true" aria-label={t(editor.kind === 'add' ? 'addMemoryTitle' : editor.kind === 'edit' ? 'editMemoryTitle' : 'deleteMemoryTitle')}>
          <header><h3>{t(editor.kind === 'add' ? 'addMemoryTitle' : editor.kind === 'edit' ? 'editMemoryTitle' : 'deleteMemoryTitle')}</h3>{editor.kind !== 'add' ? <small>{editor.item.title}</small> : null}</header>
          {editor.kind === 'delete' ? <><p>{t('deleteHint')}</p><dl className={css.deleteFacts}><div><dt>{t('groupTaskGroup')}</dt><dd>{editor.item.kind}</dd></div><div><dt>{t('evidenceSources')}</dt><dd>{t('sourceCount', { count: editor.item.sourceIds.length })}</dd></div></dl></> : <label><span>{t('memoryContent')}</span><textarea autoFocus maxLength={16_000} placeholder={t('addPlaceholder')} value={editor.content} onChange={(event) => { const content = event.currentTarget.value; setEditor(current => current?.kind === 'add' ? { ...current, content } : current?.kind === 'edit' ? { ...current, content } : current); setEditorStatus('idle') }} /></label>}
          {editorStatus === 'conflict' ? <p className={css.editorError} role="alert">{t('conflict')}</p> : editorStatus === 'error' ? <p className={css.editorError} role="alert">{t('explicitRequestFailed')}</p> : null}
          <footer><button type="button" onClick={() => { setEditor(undefined) }} disabled={editorStatus === 'submitting'}>{t('cancel')}</button><button type="submit" className={editor.kind === 'delete' ? css.dangerButton : undefined} disabled={editorStatus === 'submitting' || (editor.kind !== 'delete' && editor.content.trim().length === 0)}>{editorStatus === 'submitting' ? t('submitting') : t(editor.kind === 'delete' ? 'confirmDelete' : editor.kind === 'edit' ? 'save' : 'addMemory')}</button></footer>
        </form>
      </div> : null}
    </Modal>
  </>
}
