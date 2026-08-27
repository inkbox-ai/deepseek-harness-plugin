import type { Paths } from './paths.js'
import { run } from './process.js'

export const SUPPORTED_DSH_VERSION = '0.1.1-rc.2'

export async function validateHarness(
  paths: Pick<Paths, 'dshBin' | 'dshHome'>,
  execute: typeof run = run,
): Promise<string> {
  try {
    const result = await execute(paths.dshBin, ['--version'], {
      env: { ...process.env, DSH_HOME: paths.dshHome },
    })
    const version = result.stdout.trim()
    if (version !== SUPPORTED_DSH_VERSION)
      throw new Error(
        `DeepSeek Harness ${SUPPORTED_DSH_VERSION} is required; found ${version || 'an unknown version'} at ${paths.dshBin}.`,
      )
    return version
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('DeepSeek Harness ')) throw error
    throw new Error(
      `DeepSeek Harness ${SUPPORTED_DSH_VERSION} was not found on PATH. Install and configure dsh before running Inkbox setup.`,
      { cause: error },
    )
  }
}
