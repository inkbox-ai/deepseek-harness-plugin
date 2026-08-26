import type { stdin, stdout } from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { type PromptIO, Prompts } from '../src/cli/prompts.js'

function promptWithAnswers(...answers: string[]) {
  const output: string[] = []
  const question = vi.fn(async () => answers.shift() ?? '')
  const io: PromptIO = {
    input: { isTTY: false } as typeof stdin,
    output: { write: vi.fn((value: string) => output.push(value)) } as unknown as typeof stdout,
    question,
    emitKeypressEvents: vi.fn(),
  }
  return { prompt: new Prompts(io), output, question }
}

describe('interactive prompt spacing', () => {
  it('adds a blank line after text and confirmation answers', async () => {
    const { prompt, output, question } = promptWithAnswers('person@example.test', 'y')
    await expect(prompt.text('Your email address')).resolves.toBe('person@example.test')
    await expect(prompt.confirm('Continue?', false)).resolves.toBe(true)
    expect(question).toHaveBeenNthCalledWith(1, 'Your email address: ')
    expect(question).toHaveBeenNthCalledWith(2, 'Continue? [y/N]: ')
    expect(output).toEqual(['\n', '\n'])
  })

  it('separates menu selections from the next wizard section', async () => {
    const { prompt, output } = promptWithAnswers('2')
    await expect(prompt.choose('Choose a channel:', ['Email', 'iMessage'])).resolves.toBe(1)
    expect(output.join('')).toContain('Choose a channel:\n  1. Email (recommended)\n  2. iMessage\n')
    expect(output.at(-1)).toBe('\n')
  })

  it('adds the same spacing to non-TTY secret input', async () => {
    const { prompt, output } = promptWithAnswers('secret-value')
    await expect(prompt.secret('API key')).resolves.toBe('secret-value')
    expect(output).toEqual(['\n'])
  })
})
