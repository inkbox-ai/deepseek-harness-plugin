import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import type { Paths } from './paths.js'

export interface RuntimeStatus {
  ready: boolean
  connected: boolean
  identity?: string
  publicUrl?: string
  pid?: number
  startedAt?: string
  updatedAt?: string
  processRunning: boolean
  statusPath: string
}

function isRunning(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function resolveStateDir(paths: Paths): Promise<string> {
  try {
    const settings = parse(await readFile(join(paths.dshHome, 'settings.yaml'), 'utf8')) as {
      inkbox?: { stateDir?: unknown }
    }
    if (typeof settings.inkbox?.stateDir === 'string' && settings.inkbox.stateDir.trim()) {
      return resolve(settings.inkbox.stateDir)
    }
  } catch {}
  return join(paths.dshHome, 'inkbox')
}

export async function readRuntimeStatus(paths: Paths): Promise<RuntimeStatus> {
  const statusPath = join(await resolveStateDir(paths), 'status.json')
  const raw = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
  const pid = typeof raw.pid === 'number' ? raw.pid : undefined
  return {
    ready: raw.ready === true,
    connected: raw.connected === true,
    ...(typeof raw.identity === 'string' ? { identity: raw.identity } : {}),
    ...(typeof raw.publicUrl === 'string' ? { publicUrl: raw.publicUrl } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(typeof raw.startedAt === 'string' ? { startedAt: raw.startedAt } : {}),
    ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
    processRunning: isRunning(pid),
    statusPath,
  }
}

export function formatRuntimeStatus(status: RuntimeStatus): string {
  const live = status.ready && status.connected && status.processRunning
  return [
    `Gateway: ${live ? 'ready' : status.processRunning ? 'starting or disconnected' : 'stopped'}`,
    `Identity: ${status.identity ?? 'unknown'}`,
    `Tunnel: ${status.connected ? 'connected' : 'disconnected'}`,
    `Process: ${status.processRunning ? `running (PID ${status.pid})` : 'not running'}`,
    `Public URL: ${status.publicUrl ?? 'unavailable'}`,
    `Started: ${status.startedAt ?? 'unknown'}`,
    `Updated: ${status.updatedAt ?? 'unknown'}`,
  ].join('\n')
}
