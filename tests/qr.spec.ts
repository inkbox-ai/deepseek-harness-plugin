import { describe, expect, it, vi } from 'vitest'
import { showQr, smsDraftLink, smsToQrPayload } from '../src/cli/qr.js'

describe('setup QR codes', () => {
  it('uses phone-camera-compatible SMSTO payloads', () => {
    expect(smsToQrPayload('+16614031457', 'START')).toBe('SMSTO:+16614031457:START')
    expect(smsToQrPayload('+15550009999', 'connect @deepseek-agent')).toBe(
      'SMSTO:+15550009999:connect @deepseek-agent',
    )
    expect(smsDraftLink('+15550009999', 'connect @deepseek-agent')).toBe(
      'sms:+15550009999?&body=connect%20%40deepseek-agent',
    )
  })

  it('renders compact QR output only in an interactive terminal', () => {
    const render = vi.fn(() => 'terminal QR')
    const write = vi.fn()
    expect(showQr('SMSTO:+15550009999:START', { isTTY: () => true, render, write })).toBe(true)
    expect(render).toHaveBeenCalledWith('SMSTO:+15550009999:START')
    expect(write).toHaveBeenCalledWith('terminal QR')

    render.mockClear()
    write.mockClear()
    expect(showQr('SMSTO:+15550009999:START', { isTTY: () => false, render, write })).toBe(false)
    expect(render).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('falls back cleanly when terminal rendering fails', () => {
    expect(
      showQr('SMSTO:+15550009999:START', {
        isTTY: () => true,
        render: () => {
          throw new Error('render failed')
        },
        write: vi.fn(),
      }),
    ).toBe(false)
  })
})
