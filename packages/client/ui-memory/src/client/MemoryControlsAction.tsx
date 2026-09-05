import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'
import type {
  MemoryProfileState,
  SessionMemoryControls,
  SessionMemoryControlsPatch,
} from '@deepseek-ai/dsh-api-remotes/client'
import { IconDataOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './MemoryControlsAction.module.css'

/** Remote operations required by the per-Session memory control. */
export interface MemoryControlsInjected {
  /** Read profile defaults and this Session's explicit revisioned controls. */
  loadControls: (sessionId: PropsRuntime<'conversation.session.header.actions'>['sessionId']) => Promise<{
    readonly profile: MemoryProfileState
    readonly controls: SessionMemoryControls
  }>
  /** Commit one optimistic control patch. */
  setControls: (
    sessionId: PropsRuntime<'conversation.session.header.actions'>['sessionId'],
    expectedRevision: number,
    patch: SessionMemoryControlsPatch,
  ) => Promise<SessionMemoryControls>
}

/** Full props for the Session-header memory control. */
export type MemoryControlsActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'memory'>
  & InjectFace<MemoryControlsInjected>

type ControlState =
  | { readonly status: 'idle' | 'loading' | 'error' }
  | { readonly status: 'ready'; readonly profile: MemoryProfileState; readonly controls: SessionMemoryControls }

type ControlName = 'use' | 'contribute'

/** Render one Session's injection and contribution policy in the conversation header. */
export function MemoryControlsAction({ sessionId, loadControls, setControls, t }: MemoryControlsActionProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<ControlState>({ status: 'idle' })
  const [saving, setSaving] = useState<ControlName>()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    let current = true
    setState({ status: 'loading' })
    void loadControls(sessionId).then(
      (value) => { if (current) setState({ status: 'ready', ...value }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [loadControls, open, sessionId])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [open])

  const update = (name: ControlName, event: ChangeEvent<HTMLSelectElement>): void => {
    if (state.status !== 'ready' || saving !== undefined) return
    const value = event.currentTarget.value as SessionMemoryControls[ControlName]
    setSaving(name)
    void setControls(sessionId, state.controls.revision, { [name]: value }).then(
      (controls) => { setState({ status: 'ready', profile: state.profile, controls }); setSaving(undefined) },
      () => { setState({ status: 'error' }); setSaving(undefined) },
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    trigger.current?.focus()
  }

  const effective = state.status === 'ready'
    ? {
      use: state.controls.use === 'inherit' ? state.profile.useByDefault : state.controls.use === 'allow',
      contribute: state.controls.contribute === 'inherit' ? state.profile.contributeByDefault : state.controls.contribute === 'allow',
    }
    : undefined

  return (
    <div ref={root} className={css.root} onKeyDown={onKeyDown}>
      <Tooltip label={t('sessionControls')} side="bottom" delayMs={500}>
        <button
          ref={trigger}
          type="button"
          className={css.trigger}
          aria-label={t('sessionControls')}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconDataOutline16 size={14} />
        </button>
      </Tooltip>
      {open ? (
        <section className={css.menu} aria-label={t('sessionControls')}>
          <header>
            <strong>{t('sessionControls')}</strong>
            <span>{t('sessionControlsHint')}</span>
          </header>
          {state.status === 'loading' || state.status === 'idle' ? <p>{t('loading')}</p> : null}
          {state.status === 'error' ? (
            <button type="button" className={css.retry} onClick={() => { setOpen(false); queueMicrotask(() => { setOpen(true) }) }}>
              {t('retry')}
            </button>
          ) : null}
          {state.status === 'ready' ? (
            <>
              {!state.profile.enabled ? <p className={css.disabled}>{t('disabled')}</p> : null}
              <label>
                <span>{t('injectControl')}</span>
                <select value={state.controls.use} disabled={saving !== undefined} onChange={(event) => { update('use', event) }}>
                  <option value="inherit">{t('inheritControl', { value: effective?.use === true ? t('allowControl') : t('denyControl') })}</option>
                  <option value="allow">{t('allowControl')}</option>
                  <option value="deny">{t('denyControl')}</option>
                </select>
              </label>
              <label>
                <span>{t('contributeControl')}</span>
                <select value={state.controls.contribute} disabled={saving !== undefined} onChange={(event) => { update('contribute', event) }}>
                  <option value="inherit">{t('inheritControl', { value: effective?.contribute === true ? t('allowControl') : t('denyControl') })}</option>
                  <option value="allow">{t('allowControl')}</option>
                  <option value="deny">{t('denyControl')}</option>
                </select>
              </label>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
