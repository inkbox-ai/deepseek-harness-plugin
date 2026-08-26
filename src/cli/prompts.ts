import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

export class Prompts {
  private readonly rl = createInterface({ input: stdin, output: stdout })

  async text(label: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    const answer = (await this.rl.question(`${label}${suffix}: `)).trim()
    return answer || defaultValue || ''
  }

  async confirm(label: string, defaultValue = true): Promise<boolean> {
    const answer = (await this.rl.question(`${label} ${defaultValue ? '[Y/n]' : '[y/N]'}: `))
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

  close(): void {
    this.rl.close()
  }
}
