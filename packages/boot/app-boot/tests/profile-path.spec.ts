import { isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProfilePathResolver } from '../src/index.ts'

describe('profilePath resolver', () => {
  it('resolves the root and relative children beneath one profile', () => {
    const root = join(process.cwd(), 'profiles', 'web')
    const profilePath = createProfilePathResolver(root)

    expect(profilePath()).toBe(root)
    expect(profilePath('memories', 'state')).toBe(join(root, 'memories', 'state'))
  })

  it('rejects ambiguous, absolute, and escaping segments', () => {
    const root = join(process.cwd(), 'profiles', 'web')
    const profilePath = createProfilePathResolver(root)

    expect(() => profilePath('')).toThrow('segments must be non-empty')
    expect(() => profilePath(isAbsolute('/tmp') ? '/tmp' : 'C:\\tmp')).toThrow('segment must be relative')
    expect(() => profilePath('..', 'other')).toThrow('escapes the active profile')
  })

  it('rejects a relative profile root', () => {
    expect(() => createProfilePathResolver('profiles/web')).toThrow('root must be absolute')
  })
})
