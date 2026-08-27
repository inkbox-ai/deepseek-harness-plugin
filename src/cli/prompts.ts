import { stdin, stdout } from 'node:process'
import { emitKeypressEvents } from 'node:readline'
import { createInterface } from 'node:readline/promises'

export interface PromptIO {
  input: typeof stdin
  output: typeof stdout
  question(label: string): Promise<string>
  emitKeypressEvents(input: typeof stdin): void
}

const defaultIO: PromptIO = {
  input: stdin,
  output: stdout,
  question: async (label) => {
    const rl = createInterface({ input: stdin, output: stdout })
    try {
      return await rl.question(label)
    } finally {
      rl.close()
    }
  },
  emitKeypressEvents,
}

export class Prompts {
  constructor(private readonly io: PromptIO = defaultIO) {}

  private async question(label: string): Promise<string> {
    const answer = await this.io.question(label)
    this.io.output.write('\n')
    return answer
  }

  async text(label: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    const answer = (await this.question(`${label}${suffix}: `)).trim()
    return answer || defaultValue || ''
  }

  async secret(label: string): Promise<string> {
    const { input, output } = this.io
    if (!input.isTTY || typeof input.setRawMode !== 'function')
      return (await this.question(`${label}: `)).trim()
    this.io.emitKeypressEvents(input)
    output.write(`${label}: `)
    const wasRaw = input.isRaw
    input.setRawMode(true)
    input.resume()
    return new Promise<string>((resolve, reject) => {
      let value = ''
      const finish = (error?: Error) => {
        input.off('keypress', onKeypress)
        input.setRawMode(Boolean(wasRaw))
        input.pause()
        output.write('\n\n')
        if (error) reject(error)
        else resolve(value.trim())
      }
      const onKeypress = (character: string | undefined, key: { name?: string; ctrl?: boolean }) => {
        if (key.ctrl && key.name === 'c') return finish(new Error('Setup cancelled'))
        if (key.name === 'return' || key.name === 'enter') return finish()
        if (key.name === 'backspace') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            output.write('\b \b')
          }
          return
        }
        if (character && !key.ctrl) {
          value += character
          output.write('*')
        }
      }
      input.on('keypress', onKeypress)
    })
  }

  async confirm(label: string, defaultValue = true): Promise<boolean> {
    const answer = (await this.question(`${label} ${defaultValue ? '[Y/n]' : '[y/N]'}: `))
      .trim()
      .toLowerCase()
    if (!answer) return defaultValue
    return answer === 'y' || answer === 'yes'
  }

  async choose(label: string, choices: readonly string[], defaultIndex = 0): Promise<number> {
    while (true) {
      this.io.output.write(`${label}\n`)
      choices.forEach((choice, index) => {
        this.io.output.write(`  ${index + 1}. ${choice}${index === defaultIndex ? ' (recommended)' : ''}\n`)
      })
      const answer = await this.text('Choose', String(defaultIndex + 1))
      const index = Number.parseInt(answer, 10) - 1
      if (Number.isInteger(index) && index >= 0 && index < choices.length) return index
      this.io.output.write(`Choose a number from 1 to ${choices.length}.\n\n`)
    }
  }

  close(): void {}
}
