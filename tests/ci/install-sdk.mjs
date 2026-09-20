import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const tarball = resolve(process.env.INKBOX_SDK_PATH ?? '')
if (!process.env.INKBOX_SDK_PATH) throw new Error('INKBOX_SDK_PATH must name the built CI SDK tarball')
const manifest = readFileSync('package.json')
const original = readFileSync('pnpm-lock.yaml', 'utf8')
const version = JSON.parse(manifest).dependencies['@inkbox/sdk']
const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json']))
if (version !== '0.7.3' || packed.name !== '@inkbox/sdk' || packed.version !== version) {
  throw new Error('CI SDK artifact must match the declared 0.7.3 dependency')
}
const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
const entry = /(  '@inkbox\/sdk@0\.7\.3':\n    resolution: )\{[^\n]+\}/
if (!entry.test(original)) throw new Error('SDK entry missing from frozen lockfile')
const replacement = original.replace(entry, `$1{integrity: ${integrity}, tarball: ${JSON.stringify(pathToFileURL(tarball).href)}}`)
console.log(`Unreleased SDK source artifact: ${integrity}; matches release lock: ${original.match(entry)[0].includes(integrity)}`)
let status = 1
try {
  // All other frozen package resolutions remain unchanged.
  writeFileSync('pnpm-lock.yaml', replacement)
  const result = spawnSync('pnpm', ['install', '--frozen-lockfile'], { stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  status = result.status ?? 1
  if (status === 0) {
    const installed = JSON.parse(readFileSync('node_modules/@inkbox/sdk/package.json'))
    if (installed.version !== version) throw new Error('CI installed an unexpected SDK version')
    const { CompanionResource } = await import(pathToFileURL(resolve('node_modules/@inkbox/sdk/dist/index.js')).href)
    if (typeof CompanionResource?.prototype.loadInitialization !== 'function') throw new Error('CI SDK is missing Companion initialization')
  }
} finally {
  writeFileSync('package.json', manifest)
  writeFileSync('pnpm-lock.yaml', original)
}
process.exit(status)
