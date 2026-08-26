import { describe, expect, it } from 'vitest'
import { toIMessagePlainText } from '../src/imessage.js'

describe('iMessage plain-text formatting', () => {
  it('removes common Markdown syntax while preserving readable content and URLs', () => {
    expect(
      toIMessagePlainText(
        '# Update\n\n**Done**\n- First item\n1. Second item\n> Note\n[`report`](https://example.test/report)\n---\n| State | Owner |\n| --- | --- |\n| Ready | Sam |\n```ts\nconst ready = true\n```',
      ),
    ).toBe(
      'Update\n\nDone\nFirst item\nSecond item\nNote\nreport: https://example.test/report\n\nState · Owner\n\nReady · Sam\n\nconst ready = true',
    )
  })

  it('leaves ordinary plain text, underscores, and bare URLs unchanged', () => {
    const text = 'Ready now. See https://example.test/a_b when you have time.'
    expect(toIMessagePlainText(text)).toBe(text)
  })
})
