import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { parse } from 'yaml'
import { SKILL_NAMES } from './constants.js'

interface Frontmatter {
  name: string
  description: string
}

export interface LoadedSkill extends Frontmatter {
  content: string
}

export function parseSkillDocument(document: string): LoadedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(document)
  if (match?.[1] === undefined || match[2] === undefined)
    throw new Error('Skill document is missing YAML frontmatter')
  const metadata = parse(match[1]) as Partial<Frontmatter>
  if (typeof metadata.name !== 'string' || typeof metadata.description !== 'string') {
    throw new Error('Skill frontmatter requires name and description')
  }
  return { name: metadata.name, description: metadata.description, content: match[2].trim() }
}

export function packagedSkillRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}

export function loadPackagedSkills(root = packagedSkillRoot()): LoadedSkill[] {
  return SKILL_NAMES.map((name) => parseSkillDocument(readFileSync(join(root, name, 'SKILL.md'), 'utf8')))
}

export function registerSkills(ctx: Context, root?: string): void {
  for (const skill of loadPackagedSkills(root)) {
    ctx.skills.register({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: false },
    })
  }
}
