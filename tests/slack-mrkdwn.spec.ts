import { describe, expect, it } from 'vitest'
import { slackMrkdwn } from '../src/slack.js'

describe('slackMrkdwn', () => {
  it('converts Markdown links, bold and headings outside code', () => {
    expect(
      slackMrkdwn('# Title\nSee **this** [docs](https://example.test/a?b=1&c=2) `[x](https://no.test)`'),
    ).toBe('*Title*\nSee *this* <https://example.test/a?b=1&amp;c=2|docs> `[x](https://no.test)`')
  })

  it('stays linear on repeated opening brackets', () => {
    const input = `[${'[\\'.repeat(50_000)}`
    const started = Date.now()
    expect(slackMrkdwn(input)).toBe(input)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
