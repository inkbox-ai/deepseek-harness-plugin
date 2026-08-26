import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'dotenv'

export async function layeredEnvironment(home: string): Promise<Record<string, string>> {
  let file: Record<string, string> = {}
  try {
    file = parse(await readFile(join(home, '.env'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return { ...file, ...inherited }
}

export function credentialFromEnvironment(
  environment: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  if (environment[name]) return environment[name]
  const variants = Object.entries(environment).filter(
    ([candidate, value]) => candidate.startsWith(`${name}_`) && value.length > 0,
  )
  if (variants.length === 1) return variants[0]?.[1]
  if (variants.length > 1)
    throw new Error(`Multiple ${name}_* values were found. Set ${name} to select one explicitly.`)
  return undefined
}
