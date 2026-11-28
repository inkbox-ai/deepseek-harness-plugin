import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PLUGIN_VERSION, SKILL_NAMES, TOOL_NAMES } from '../src/constants.js'
import { loadPackagedSkills } from '../src/skills.js'
import { TOOL_CATALOG } from '../src/tools.js'

describe('communication capability catalog', () => {
  it('reports the same CLI and package version', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(PLUGIN_VERSION).toBe(manifest.version)
  })

  it('registers exactly the 38 native tools', () => {
    expect(TOOL_CATALOG.map((tool) => tool.name)).toEqual([...TOOL_NAMES])
    expect(new Set(TOOL_NAMES).size).toBe(38)
  })

  it('leaves catalog-served tool groups to the remote Inkbox tools', () => {
    const names = TOOL_CATALOG.map((tool) => tool.name).join(' ')
    expect(names).not.toMatch(/note|contact_rule|list_email|get_email|list_call|get_call/)
  })

  it('packages exactly 13 model-invocable skills', () => {
    const skills = loadPackagedSkills()
    expect(skills.map((skill) => skill.name)).toEqual([...SKILL_NAMES])
    expect(skills).toHaveLength(13)
    expect(skills.every((skill) => skill.content.length > 200)).toBe(true)
  })

  it('keeps skill guidance host-specific and free of sibling implementation names', () => {
    const content = loadPackagedSkills()
      .map((skill) => `${skill.description}\n${skill.content}`)
      .join('\n')
    expect(content).not.toMatch(/Hermes|Claude Code|OpenCode|OpenClaw|Codex plugin/i)
  })

  it('guides Vault unlock for hosted and self-hosted agents and notes through remote tools', () => {
    const skill = (name: string) =>
      loadPackagedSkills().find((candidate) => candidate.name === name)?.content ?? ''
    const credentials = skill('inkbox-credential-use')
    for (const name of TOOL_NAMES.filter((tool) => /credential|totp/.test(tool)))
      expect(credentials).toContain(name)
    expect(credentials).toMatch(/INKBOX_DEEPSEEK_VAULT_KEY/)
    expect(credentials).toMatch(/Hosted by Inkbox:.*Env vars tab/)
    expect(credentials).toMatch(/Self-hosted:.*export it/)
    expect(skill('inkbox-notes-memory')).toMatch(/inkbox_remote_tools[\s\S]*inkbox_remote_call/)
  })

  it.each([
    'inkbox_send_email',
    'inkbox_send_sms',
    'inkbox_send_imessage',
    'inkbox_place_call',
    'inkbox_a2a_call',
  ])('%s declares an approval reason', (name) => {
    expect(TOOL_CATALOG.find((tool) => tool.name === name)?.approval).toBeTypeOf('function')
  })

  it.each(['inkbox_a2a_complete', 'inkbox_a2a_ask_caller', 'inkbox_a2a_fail'])(
    '%s can answer the already-authorized inbound task without a second human channel',
    (name) => {
      expect(TOOL_CATALOG.find((tool) => tool.name === name)?.approval).toBeUndefined()
    },
  )
})
