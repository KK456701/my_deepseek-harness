import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type {
  MemoryRuntimeSettings,
  MemoryRuntimeSettingsPatch,
  MemoryRuntimeSettingsValues,
  MemoryProfileState,
  MemoryProfileControlPatch,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { MemoryLocaleKey } from './locales.ts'
import css from './MemoryArea.module.css'

type Translate = (key: MemoryLocaleKey, params?: Record<string, unknown>) => string
type NumericSetting = {
  [K in keyof MemoryRuntimeSettingsValues]: MemoryRuntimeSettingsValues[K] extends number ? K : never
}[keyof MemoryRuntimeSettingsValues]

interface NumericField {
  readonly key: NumericSetting
  readonly label: MemoryLocaleKey
  readonly unit: MemoryLocaleKey
  readonly scale?: number
  readonly step?: number
}

const ELIGIBILITY: readonly NumericField[] = [
  { key: 'rebuildLookbackMs', label: 'rebuildLookback', unit: 'days', scale: 24 * 60 * 60_000, step: 0.25 },
  { key: 'idleMs', label: 'idleDuration', unit: 'hours', scale: 60 * 60_000, step: 0.25 },
  { key: 'maxSourceAgeMs', label: 'maxSourceAge', unit: 'days', scale: 24 * 60 * 60_000, step: 0.25 },
  { key: 'maxUnusedDays', label: 'maxUnusedDays', unit: 'days' },
  { key: 'minRemainingQuotaPercent', label: 'minRemainingQuota', unit: 'percent' },
  { key: 'scanSessionsPerRun', label: 'scanSessions', unit: 'count' },
  { key: 'maxRangesPerRun', label: 'sourceRanges', unit: 'count' },
]

const THROUGHPUT: readonly NumericField[] = [
  { key: 'maxPhase1ClaimsPerRun', label: 'phase1Claims', unit: 'count' },
  { key: 'phase1Concurrency', label: 'phase1Concurrency', unit: 'count' },
  { key: 'maxCandidatesPerRange', label: 'candidatesPerRange', unit: 'count' },
  { key: 'maxPhase2Sources', label: 'phase2Candidates', unit: 'count' },
  { key: 'phase2SearchMaxFiles', label: 'searchFiles', unit: 'count' },
  { key: 'phase2SearchMaxMatches', label: 'searchMatches', unit: 'count' },
  { key: 'skillMinSupportingTasks', label: 'skillSupportingTasks', unit: 'count' },
  { key: 'recallMaxPasses', label: 'recallPasses', unit: 'count' },
  { key: 'recallMaxToolCalls', label: 'recallToolCalls', unit: 'count' },
  { key: 'recallMaxDetailFiles', label: 'recallDetailFiles', unit: 'count' },
]

const RELIABILITY: readonly NumericField[] = [
  { key: 'providerTimeoutMs', label: 'providerTimeout', unit: 'minutes', scale: 60_000, step: 0.5 },
  { key: 'maxAttempts', label: 'maxAttempts', unit: 'count' },
  { key: 'retryBaseMs', label: 'retryDelay', unit: 'minutes', scale: 60_000, step: 0.25 },
  { key: 'phase1LeaseMs', label: 'phase1Lease', unit: 'minutes', scale: 60_000, step: 0.5 },
  { key: 'phase2LeaseMs', label: 'phase2Lease', unit: 'minutes', scale: 60_000, step: 0.5 },
  { key: 'fallbackWakeMs', label: 'fallbackWake', unit: 'minutes', scale: 60_000, step: 0.5 },
]

const LIMITS: readonly NumericField[] = [
  { key: 'maxEvidenceBytes', label: 'evidenceLimit', unit: 'mib', scale: 1024 * 1024, step: 0.25 },
  { key: 'maxResultBytes', label: 'resultLimit', unit: 'mib', scale: 1024 * 1024, step: 0.25 },
  { key: 'phase2MaxFileBytes', label: 'phase2FileLimit', unit: 'mib', scale: 1024 * 1024, step: 0.25 },
  { key: 'promptSummaryMaxBytes', label: 'promptSummaryLimit', unit: 'kib', scale: 1024, step: 1 },
  { key: 'policyVersion', label: 'policyVersion', unit: 'version' },
  { key: 'pruneRowsPerRun', label: 'pruneRows', unit: 'count' },
  { key: 'pruneBytesPerRun', label: 'pruneBytes', unit: 'mib', scale: 1024 * 1024, step: 1 },
]

function values(settings: MemoryRuntimeSettings): MemoryRuntimeSettingsValues {
  const { revision: _revision, ...result } = settings
  return result
}

/** Runtime settings editor; committed values apply to later scheduler passes. */
export function MemorySettingsPanel({
  profile,
  saveProfile,
  settings,
  save,
  reset,
  t,
}: {
  readonly profile: MemoryProfileState
  readonly saveProfile: (expectedRevision: number, patch: MemoryProfileControlPatch) => Promise<MemoryProfileState>
  readonly settings: MemoryRuntimeSettings
  readonly save: (expectedRevision: number, patch: MemoryRuntimeSettingsPatch) => Promise<MemoryRuntimeSettings>
  readonly reset: () => Promise<void>
  readonly t: Translate
}): ReactNode {
  const [draft, setDraft] = useState<MemoryRuntimeSettingsValues>(() => values(settings))
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [profileStatus, setProfileStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const [resetStatus, setResetStatus] = useState<'idle' | 'armed' | 'resetting' | 'error'>('idle')

  useEffect(() => {
    setDraft(values(settings))
    setStatus('idle')
  }, [settings])

  const numericField = (field: NumericField): ReactNode => {
    const scale = field.scale ?? 1
    return (
      <label key={field.key}>
        <span>{t(field.label)}</span>
        <span className={css.settingInput}>
          <input
            type="number"
            min={field.step ?? 1}
            step={field.step ?? 1}
            value={draft[field.key] / scale}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber
              if (!Number.isFinite(value)) return
              setDraft(current => ({ ...current, [field.key]: Math.round(value * scale) }))
              setStatus('idle')
            }}
          />
          <small aria-hidden="true">{t(field.unit)}</small>
        </span>
      </label>
    )
  }

  const textField = (key: 'extractionProvider' | 'extractionModel' | 'extractionReasoningEffort' | 'consolidationProvider' | 'consolidationModel' | 'consolidationReasoningEffort', label: MemoryLocaleKey): ReactNode => (
    <label><span>{t(label)}</span><input value={draft[key]} onChange={(event) => {
      const value = event.currentTarget.value
      setDraft(current => ({ ...current, [key]: value }))
      setStatus('idle')
    }} /></label>
  )

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (status === 'saving') return
    setStatus('saving')
    void save(settings.revision, draft).then(
      (committed) => { setDraft(values(committed)); setStatus('saved') },
      () => { setStatus('error') },
    )
  }

  return (
    <form className={css.settingsPanel} onSubmit={submit}>
      <section>
        <h3>{t('profileControls')}</h3>
        <div className={css.settingGrid}>
          {([
            ['enabled', 'enabledControl'],
            ['useByDefault', 'useDefaultControl'],
            ['contributeByDefault', 'contributeDefaultControl'],
          ] as const).map(([key, label]) => (
            <label key={key}>
              <span>{t(label)}</span>
              <input
                type="checkbox"
                checked={profile[key]}
                disabled={profileStatus === 'saving'}
                onChange={(event) => {
                  setProfileStatus('saving')
                  void saveProfile(profile.controlRevision, { [key]: event.currentTarget.checked }).then(
                    () => { setProfileStatus('idle') },
                    () => { setProfileStatus('error') },
                  )
                }}
              />
            </label>
          ))}
        </div>
        {profileStatus === 'error' ? <p role="alert">{t('settingsFailed')}</p> : null}
      </section>
      <div className={css.settingsIntro}>
        <div>
          <strong>{t('liveSettings')}</strong>
          <p>{t('liveSettingsHint')}</p>
        </div>
        <span>{t('settingsRevision', { revision: settings.revision })}</span>
      </div>

      <section>
        <h3>{t('eligibilitySettings')}</h3>
        <div className={css.settingGrid}>{ELIGIBILITY.map(numericField)}</div>
        <label>
          <span>{t('externalContextGuard')}</span>
          <input type="checkbox" checked={draft.disableOnExternalContext} onChange={(event) => {
            const checked = event.currentTarget.checked
            setDraft(current => ({ ...current, disableOnExternalContext: checked }))
            setStatus('idle')
          }} />
        </label>
        <p>{t('externalContextGuardHint')}</p>
      </section>

      <section>
        <h3>{t('modelSettings')}</h3>
        <p>{t('codexBackendHint')}</p>
        <div className={css.settingGrid}>
          {(['extractionBackend', 'consolidationBackend'] as const).map(key => <label key={key}><span>{t(key)}</span><select value={draft[key]} onChange={(event) => { const value = event.currentTarget.value; if (value === 'llm' || value === 'codex') setDraft(current => ({ ...current, [key]: value })); setStatus('idle') }}><option value="llm">LLM Provider</option><option value="codex">Codex app-server</option></select></label>)}
          {textField('extractionReasoningEffort', 'extractionReasoning')}
          {draft.extractionBackend === 'llm' ? textField('extractionProvider', 'extractionProvider') : null}
          {textField('extractionModel', 'extractionModel')}
          {draft.extractionBackend === 'llm' ? numericField({ key: 'extractionMaxTokens', label: 'extractionTokens', unit: 'tokens' }) : null}
          {draft.consolidationBackend === 'llm' ? textField('consolidationProvider', 'consolidationProvider') : null}
          {textField('consolidationModel', 'consolidationModel')}
          {textField('consolidationReasoningEffort', 'consolidationReasoning')}
          {draft.consolidationBackend === 'llm' ? numericField({ key: 'consolidationMaxTokens', label: 'consolidationTokens', unit: 'tokens' }) : null}
        </div>
      </section>

      <section>
        <h3>{t('throughputSettings')}</h3>
        <div className={css.settingGrid}>{THROUGHPUT.map(numericField)}</div>
      </section>

      <section>
        <h3>{t('reliabilitySettings')}</h3>
        <div className={css.settingGrid}>{RELIABILITY.map(numericField)}</div>
      </section>

      <section>
        <h3>{t('evidenceSettings')}</h3>
        <div className={css.settingGrid}>
          {LIMITS.map(numericField)}
          <label className={css.wideSetting}>
            <span>{t('externalPrefixes')}</span>
            <input
              value={draft.externalToolPrefixes.join(', ')}
              onChange={(event) => {
                const externalToolPrefixes = event.currentTarget.value.split(/[\s,]+/u).filter(Boolean)
                setDraft(current => ({ ...current, externalToolPrefixes }))
                setStatus('idle')
              }}
            />
          </label>
        </div>
      </section>

      <footer className={css.settingsFooter}>
        <span role={status === 'error' ? 'alert' : undefined}>
          {status === 'saved' ? t('settingsSaved') : status === 'error' ? t('settingsFailed') : t('settingsApplyHint')}
        </span>
        <button type="submit" disabled={status === 'saving'}>{status === 'saving' ? t('settingsSaving') : t('saveSettings')}</button>
      </footer>
      <section>
        <h3>{t('resetTitle')}</h3>
        <p>{t('resetHint')}</p>
        <button
          type="button"
          disabled={resetStatus === 'resetting'}
          onClick={() => {
            if (resetStatus !== 'armed') {
              setResetStatus('armed')
              return
            }
            setResetStatus('resetting')
            void reset().then(
              () => { setResetStatus('idle') },
              () => { setResetStatus('error') },
            )
          }}
        >
          {resetStatus === 'armed' ? t('resetConfirm') : resetStatus === 'resetting' ? t('resetting') : t('resetMemory')}
        </button>
        {resetStatus === 'error' ? <p role="alert">{t('resetFailed')}</p> : null}
      </section>
    </form>
  )
}
