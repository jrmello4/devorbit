import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))

import { parsePortableManifest } from '../src/main/updater'

const requireCjs = createRequire(import.meta.url)
const generator = requireCjs('../scripts/generate-portable-manifest.cjs') as {
  generatePortableManifest: (options: { releaseDir: string; version: string }) => {
    manifestPath: string
    portablePath: string
    sha512: string
    version: string
  }
  portableArtifactName: (version: string) => string
  PORTABLE_MANIFEST_NAME: string
}

let releaseDir = ''

beforeEach(async () => {
  releaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-portable-manifest-'))
})

afterEach(async () => {
  await fs.rm(releaseDir, { recursive: true, force: true })
})

describe('gerador do manifesto portátil', () => {
  it('gera latest-portable.yml válido e reconhecido pelo updater', async () => {
    const version = '9.9.9'
    const portableName = generator.portableArtifactName(version)
    const bytes = Buffer.from('portable-binary-fixture')
    await fs.writeFile(path.join(releaseDir, portableName), bytes)

    const result = generator.generatePortableManifest({ releaseDir, version })
    expect(path.basename(result.manifestPath)).toBe(generator.PORTABLE_MANIFEST_NAME)

    const content = await fs.readFile(result.manifestPath, 'utf-8')
    const expectedSha = createHash('sha512').update(bytes).digest('hex').toLowerCase()
    expect(content).toContain(`version: ${version}`)
    expect(content).toContain(`path: ${portableName}`)
    expect(content).toContain(expectedSha)

    // A mesma lógica que o updater usa no auto-update portátil reconhece o manifesto.
    expect(parsePortableManifest(content)).toEqual({ version, path: portableName, sha512: expectedSha })
  })

  it('recusa gerar quando o executável portátil não existe', () => {
    expect(() => generator.generatePortableManifest({ releaseDir, version: '1.0.0' })).toThrow(/port[aá]til/i)
  })
})
