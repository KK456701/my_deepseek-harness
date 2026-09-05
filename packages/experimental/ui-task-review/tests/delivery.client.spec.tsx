// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DeliveryReview } from '../src/client/delivery.tsx'

afterEach(cleanup)

function props(disposition: 'rejected' | 'replaced' | undefined) {
  const turn = { turn: 1 }
  const nodes = disposition === undefined ? [] : [
    { kind: 'task-review-delivery-marker', data: { turn: 1, candidateSeq: 4 } },
    ...(disposition === 'replaced'
      ? [{ kind: 'assistant-step', data: { turn: 1, finalNode: { seq: 9 } } }]
      : []),
  ]
  return {
    matched: {
      node: { data: { finalNode: { seq: 4 } } },
      turn,
      messageSeq: 4,
      content: <p>第一版回答</p>,
    },
    useSession: (selector: (snapshot: unknown) => unknown) => selector({
      views: { get: (target: string) => target === 'task-review-delivery'
        ? { markers: nodes.filter(node => node.kind === 'task-review-delivery-marker').map(node => node.data) }
        : undefined },
      chat: { nodes: { values: () => nodes } },
    }),
  } as unknown as Parameters<typeof DeliveryReview>[0]
}

describe('post-delivery review disclosure', () => {
  it('defaults a rejected answer to collapsed and preserves manual replay', () => {
    const { container } = render(<DeliveryReview {...props('rejected')} />)
    const details = container.querySelector('details')!
    expect(details.open).toBe(false)
    expect(screen.getByText('审查未通过')).toBeTruthy()
    fireEvent.click(screen.getByText('审查未通过'))
    expect(details.open).toBe(true)
    expect(screen.getByText('第一版回答')).toBeTruthy()
  })

  it('labels a rejected answer after a later Assistant replacement', () => {
    render(<DeliveryReview {...props('replaced')} />)
    expect(screen.getByText('已被修正版替代')).toBeTruthy()
  })

  it('renders an accepted answer without disclosure chrome', () => {
    const { container } = render(<DeliveryReview {...props(undefined)} />)
    expect(container.querySelector('details')).toBeNull()
    expect(screen.getByText('第一版回答')).toBeTruthy()
  })
})
