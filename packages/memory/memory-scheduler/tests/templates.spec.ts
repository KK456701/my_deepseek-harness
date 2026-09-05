import { createHash } from 'node:crypto'

import { MEMORY_TEMPLATE_VERSION } from '@deepseek-ai/dsh-memory'
import { describe, expect, it } from 'vitest'

import { MEMORY_TEMPLATE_FINGERPRINT_TEXT } from '../src/templates.ts'

describe('memory model templates', () => {
  it('binds the published template identity to the canonical prompt bytes', () => {
    const digest = createHash('sha256').update(MEMORY_TEMPLATE_FINGERPRINT_TEXT).digest('hex')

    expect(MEMORY_TEMPLATE_VERSION).toBe(`sha256-${digest}`)
  })

  it('keeps product prompts free of fixture-specific promotion terms', () => {
    expect(MEMORY_TEMPLATE_FINGERPRINT_TEXT).not.toMatch(/腾讯|小红书|作文|subagent/i)
  })
})
