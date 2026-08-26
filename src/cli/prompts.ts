import { stdin, stdout } from 'node:process'
import { emitKeypressEvents } from 'node:readline'
import { createInterface } from 'node:readline/promises'

export class Prompts {
  private async question(label: string): Promise<string> {
    const rl = createInterface({ input: stdin, output: stdout })
    try {
      return await rl.question(label)
    } finally {
      rl.close()
    }
  }

  async text(label: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    const answer = (await this.question(`${label}${suffix}: `)).trim()
    return answer || defaultValue || ''
  }

  async secret(label: string): Promise<string> {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function')
      return (await this.question(`${label}: `)).trim()
    emitKeypressEvents(stdin)
    stdout.write(`${label}: `)
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    return new Promise<string>((resolve, reject) => {
      let value = ''
      const finish = (error?: Error) => {
        stdin.off('keypress', onKeypress)
        stdin.setRawMode(Boolean(wasRaw))
        stdin.pause()
        stdout.write('\n')
        if (error) reject(error)
        else resolve(value.trim())
      }
      const onKeypress = (character: string | undefined, key: { name?: string; ctrl?: boolean }) => {
        if (key.ctrl && key.name === 'c') return finish(new Error('Setup cancelled'))
        if (key.name === 'return' || key.name === 'enter') return finish()
        if (key.name === 'backspace') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            stdout.write('\b \b')
          }
          return
        }
        if (character && !key.ctrl) {
          value += character
          stdout.write('*')
        }
      }
      stdin.on('keypress', onKeypress)
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
    stdout.write(`${label}\n`)
    choices.forEach((choice, index) => {
      stdout.write(`  ${index + 1}. ${choice}${index === defaultIndex ? ' (recommended)' : ''}\n`)
    })
    const answer = await this.text('Choose', String(defaultIndex + 1))
    const index = Number.parseInt(answer, 10) - 1
    if (!Number.isInteger(index) || index < 0 || index >= choices.length) throw new Error('Invalid selection')
    return index
  }

  close(): void {}
}
