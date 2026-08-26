import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { parse, stringify } from 'yaml'

type Document = Record<string, unknown>

async function ensureFile(path: string, initial: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'wx', mode).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return undefined
    throw error
  })
  if (handle === undefined) return
  try {
    await handle.writeFile(initial, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function updateYaml(
  path: string,
  change: (document: Document) => void,
  mode = 0o600,
): Promise<void> {
  await ensureFile(path, '{}\n', mode)
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 10, minTimeout: 20, maxTimeout: 250 },
  })
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = (parse(raw) ?? {}) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error(`${path} must contain a YAML object`)
    const document = parsed as Document
    change(document)
    const temp = `${path}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`
    await writeFile(temp, stringify(document), { encoding: 'utf8', mode, flag: 'wx' })
    await rename(temp, path)
    await chmod(path, mode)
  } finally {
    await release()
  }
}

export async function readYaml(path: string): Promise<Document | undefined> {
  try {
    const parsed = parse(await readFile(path, 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Document)
      : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
