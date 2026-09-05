// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import {
  SkillSettingsSection,
  type SkillSettingsSectionInjected,
  type SkillSettingsSectionProps,
} from '../src/client/SkillSettingsSection.tsx'
import { en, type SkillKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: SkillKey): string => en[key]) as SkillSettingsSectionProps['t']

function props(list: SkillSettingsSectionInjected['list']): SkillSettingsSectionProps {
  return { t, list } as SkillSettingsSectionProps
}

const SKILLS: readonly SkillEntry[] = [
  {
    name: 'code-review',
    description: 'Review a change before it ships.',
    whenToUse: 'Use for pull request reviews.',
    modelInvocable: true,
  },
  {
    name: 'resume',
    description: 'Create an editable resume.',
    modelInvocable: false,
  },
]

describe('SkillSettingsSection', () => {
  it('lists the current catalog with invocation badges and filters all copy fields', async () => {
    const deferred = Promise.withResolvers<readonly SkillEntry[] | null>()
    const list = vi.fn(() => deferred.promise)
    render(<SkillSettingsSection {...props(list)} />)
    expect(screen.getByText(en['settings.loading'])).toBeTruthy()

    await act(async () => { deferred.resolve(SKILLS) })
    expect(list).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: en['settings.title'] })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: en['settings.searchLabel'] })).toBeTruthy()
    expect(screen.getByText('/code-review')).toBeTruthy()
    expect(screen.getByText('/resume')).toBeTruthy()
    expect(screen.getByText(en['settings.modelInvocable'])).toBeTruthy()
    expect(screen.getByText(en['settings.userOnly'])).toBeTruthy()
    expect(screen.getByText('Use for pull request reviews.')).toBeTruthy()

    fireEvent.change(screen.getByRole('textbox', { name: en['settings.searchLabel'] }), {
      target: { value: 'pull request' },
    })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('/code-review')).toBeTruthy()

    fireEvent.change(screen.getByRole('textbox', { name: en['settings.searchLabel'] }), {
      target: { value: 'not-installed' },
    })
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByText(en['settings.noResults'])).toBeTruthy()
  })

  it('distinguishes no session, empty catalog, and a retryable failure', async () => {
    const noSession = render(<SkillSettingsSection {...props(async () => null)} />)
    expect(await screen.findByText(en['settings.noSession'])).toBeTruthy()
    noSession.unmount()

    const empty = render(<SkillSettingsSection {...props(async () => [])} />)
    expect(await screen.findByText(en['settings.empty'])).toBeTruthy()
    empty.unmount()

    const list = vi.fn<SkillSettingsSectionInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce(SKILLS)
    render(<SkillSettingsSection {...props(list)} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en['settings.error'])
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['settings.retry'] }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText('/code-review')).toBeTruthy()
  })
})
