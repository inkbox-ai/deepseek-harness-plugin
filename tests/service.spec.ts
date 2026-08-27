import { describe, expect, it } from 'vitest'
import { renderLaunchdPlist, renderSystemdUnit } from '../src/cli/service.js'

const paths = {
  home: '/home/test user',
  dshHome: '/home/test user/.dsh',
  dshBin: '/home/test user/.local/bin/dsh',
  localBin: '/home/test user/.local/bin',
  packageRoot: '/plugin',
}

describe('managed service definitions', () => {
  it('renders a Linux user service with absolute runtime, profile, home, and workspace', () => {
    const unit = renderSystemdUnit(paths, '/work/project one')
    expect(unit).toContain('--profile inkbox')
    expect(unit).toContain(`ExecStart="${paths.dshBin}" --profile inkbox`)
    expect(unit).toContain('WorkingDirectory=/work/project\\x20one')
    expect(unit).toContain('Environment="DSH_HOME=/home/test user/.dsh"')
    expect(unit).toContain('Restart=on-failure')
  })

  it('never embeds API keys in the Linux unit', () => {
    expect(renderSystemdUnit(paths, '/work')).not.toMatch(/API_KEY|credential|secret/i)
  })

  it('renders a macOS user agent with structured arguments and escaped paths', () => {
    const plist = renderLaunchdPlist(paths, '/work/a&b')
    expect(plist).toContain('<string>--profile</string><string>inkbox</string>')
    expect(plist).toContain(`<string>${paths.dshBin}</string><string>--profile</string>`)
    expect(plist).toContain('/work/a&amp;b')
    expect(plist).toContain('<key>KeepAlive</key>')
  })

  it('never embeds API keys in the macOS plist', () => {
    expect(renderLaunchdPlist(paths, '/work')).not.toMatch(/API_KEY|credential|secret/i)
  })
})
