import { describe, expect, it } from 'vitest'
import { renderLaunchdPlist, renderSystemdUnit } from '../src/cli/service.js'

const paths = {
  home: '/home/test user',
  dshHome: '/home/test user/.dsh',
  runtimeDir: '/home/test user/.dsh/runtime',
  dshBin: '/home/test user/.dsh/runtime/node_modules/.bin/dsh',
  localBin: '/home/test user/.local/bin',
  packageRoot: '/plugin',
}

describe('managed service definitions', () => {
  it('renders a Linux user service with absolute runtime, profile, home, and workspace', () => {
    const unit = renderSystemdUnit(paths, '/work/project one')
    expect(unit).toContain('--profile inkbox')
    expect(unit).toContain(`"${paths.runtimeDir}/node_modules/@deepseek-ai/dsh/lib/bin.js"`)
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
    expect(plist).toContain(`<string>${paths.runtimeDir}/node_modules/@deepseek-ai/dsh/lib/bin.js</string>`)
    expect(plist).toContain('/work/a&amp;b')
    expect(plist).toContain('<key>KeepAlive</key>')
  })

  it('never embeds API keys in the macOS plist', () => {
    expect(renderLaunchdPlist(paths, '/work')).not.toMatch(/API_KEY|credential|secret/i)
  })
})
