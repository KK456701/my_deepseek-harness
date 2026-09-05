import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconSearchOutline16,
  IconSkillOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SkillSettingsSection.module.css'

/** Registration-side face for the current session's skill catalog. */
export interface SkillSettingsSectionInjected {
  /** List the current session's skills, or return null when no session is selected. */
  list: () => Promise<readonly SkillEntry[] | null>
}

/** Full component props assembled by the Settings slot renderer. */
export type SkillSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'skill'>
  & InjectFace<SkillSettingsSectionInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly skills: readonly SkillEntry[] | null }

/** Whether one skill matches the local catalog query. */
function matches(skill: SkillEntry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [skill.name, skill.description, skill.whenToUse]
    .some(value => value?.toLocaleLowerCase().includes(normalizedQuery) === true)
}

/** Render the read-only skill catalog for the selected session. */
export function SkillSettingsSection({ list, t }: SkillSettingsSectionProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (skills) => { if (current) setState({ status: 'ready', skills }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = useMemo(
    () => state.status === 'ready' && state.skills !== null
      ? state.skills.filter(skill => matches(skill, normalizedQuery))
      : [],
    [normalizedQuery, state],
  )

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  return (
    <section className={css.section} aria-busy={state.status === 'loading'} data-skill-settings>
      <header className={css.header}>
        <h2>{t('settings.title')}</h2>
        <p>{t('settings.intro')}</p>
      </header>

      {state.status === 'loading' ? <p className={css.status}>{t('settings.loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('settings.error')}</p>
          <button type="button" onClick={retry}>{t('settings.retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' && state.skills === null ? (
        <div className={css.empty}>
          <IconSkillOutline16 size={20} />
          <p>{t('settings.noSession')}</p>
        </div>
      ) : null}
      {state.status === 'ready' && state.skills !== null ? (
        <div className={css.catalog}>
          <label className={css.search}>
            <IconSearchOutline16 size={16} />
            <span className={css.hiddenLabel}>{t('settings.searchLabel')}</span>
            <input
              value={query}
              placeholder={t('settings.searchPlaceholder')}
              onChange={(event) => { setQuery(event.target.value) }}
            />
          </label>

          <div className={css.catalogHeading}>
            <h3>{t('settings.catalog')}</h3>
            <span>{t('settings.count').replace('{count}', String(filtered.length))}</span>
          </div>

          {filtered.length === 0 ? (
            <div className={css.empty}>
              <IconSkillOutline16 size={20} />
              <p>{state.skills.length === 0 ? t('settings.empty') : t('settings.noResults')}</p>
            </div>
          ) : (
            <ul className={css.cards}>
              {filtered.map(skill => (
                <li key={skill.name} className={css.card} data-skill-name={skill.name}>
                  <div className={css.cardHeader}>
                    <code>/{skill.name}</code>
                    <span className={css.badge} data-model-invocable={skill.modelInvocable}>
                      {skill.modelInvocable
                        ? t('settings.modelInvocable')
                        : t('settings.userOnly')}
                    </span>
                  </div>
                  <p className={css.description}>{skill.description}</p>
                  {skill.whenToUse === undefined ? null : (
                    <p className={css.whenToUse}>
                      <span>{t('settings.whenToUse')}</span>
                      {skill.whenToUse}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  )
}
