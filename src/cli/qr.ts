import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

interface QrTerminal {
  generate(input: string, options: { small: boolean }, callback: (output: string) => void): void
}

export interface QrDependencies {
  isTTY(): boolean
  render(data: string): string
  write(output: string): void
}

const defaults: QrDependencies = {
  isTTY: () => Boolean(process.stdout.isTTY),
  render: (data) => {
    const qr = require('qrcode-terminal') as QrTerminal
    let rendered: string | undefined
    qr.generate(data, { small: true }, (output) => {
      rendered = output
    })
    if (!rendered) throw new Error('QR renderer returned no output')
    return rendered
  },
  write: (output) => process.stdout.write(`${output}\n`),
}

export function smsToQrPayload(number: string, body: string): string {
  return `SMSTO:${number}:${body}`
}

export function smsDraftLink(number: string, body: string): string {
  return `sms:${number}?&body=${encodeURIComponent(body)}`
}

export function showQr(data: string, dependencies: QrDependencies = defaults): boolean {
  if (!dependencies.isTTY()) return false
  try {
    dependencies.write(dependencies.render(data))
    return true
  } catch {
    return false
  }
}
