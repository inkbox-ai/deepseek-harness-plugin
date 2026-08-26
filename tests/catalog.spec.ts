import { describe, expect, it } from 'vitest'
import { SKILL_NAMES, TOOL_NAMES } from '../src/constants.js'
import { loadPackagedSkills } from '../src/skills.js'
import { TOOL_CATALOG } from '../src/tools.js'

describe('communication capability catalog', () => {
  it('registers exactly the 33 social-tier tools', () => {
    expect(TOOL_CATALOG.map((tool) => tool.name)).toEqual([...TOOL_NAMES])
    expect(new Set(TOOL_NAMES).size).toBe(33)
  })

  it('excludes power-assistant-only tool groups', () => {
    const names = TOOL_CATALOG.map((tool) => tool.name).join(' ')
    expect(names).not.toMatch(/note|vault|credential|contact_rule|list_email|get_email|list_call|get_call/)
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

  it.each([
    'inkbox_send_email',
    'inkbox_send_sms',
    'inkbox_send_imessage',
    'inkbox_place_call',
    'inkbox_a2a_call',
  ])('%s declares an approval reason', (name) => {
    expect(TOOL_CATALOG.find((tool) => tool.name === name)?.approval).toBeTypeOf('function')
  })
})
