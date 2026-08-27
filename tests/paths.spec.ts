import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findExecutable, resolvePaths } from '../src/cli/paths.js'

describe('DeepSeek Harness discovery', () => {
  it('resolves dsh from PATH without installing another runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkbox-dsh-path-'))
    const dsh = join(root, 'dsh')
    await writeFile(dsh, '#!/bin/sh\n', { mode: 0o700 })
    await chmod(dsh, 0o700)

    expect(findExecutable('dsh', { PATH: `${root}${delimiter}/usr/bin` })).toBe(dsh)
    expect(resolvePaths({ HOME: root, PATH: root }).dshBin).toBe(dsh)
  })
})
