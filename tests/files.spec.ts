import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { readYaml, updateYaml } from '../src/cli/files.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('secure YAML updates', () => {
  it('preserves unrelated settings while updating one namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkbox-yaml-'))
    roots.push(root)
    const path = join(root, 'settings.yaml')
    await writeFile(path, 'other:\n  enabled: true\n')
    await updateYaml(path, (document) => {
      document.inkbox = { agentHandle: 'agent' }
    })
    expect(parse(await readFile(path, 'utf8'))).toEqual({
      other: { enabled: true },
      inkbox: { agentHandle: 'agent' },
    })
  })

  it('serializes concurrent writers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkbox-yaml-'))
    roots.push(root)
    const path = join(root, 'credentials.yaml')
    await Promise.all([
      updateYaml(path, (document) => {
        document.first = true
      }),
      updateYaml(path, (document) => {
        document.second = true
      }),
    ])
    expect(await readYaml(path)).toMatchObject({ first: true, second: true })
  })

  it('returns undefined for an absent document', async () => {
    expect(await readYaml('/tmp/inkbox-definitely-absent/settings.yaml')).toBeUndefined()
  })
})
