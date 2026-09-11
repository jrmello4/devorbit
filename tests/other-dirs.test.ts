import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listAllNonProjectDirs, listNonProjectDirs } from '../src/main/scanner'

let root = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-other-'))
  await fs.mkdir(path.join(root, 'empty-folder'), { recursive: true })
  await fs.mkdir(path.join(root, 'git-repo', '.git'), { recursive: true })
  await fs.mkdir(path.join(root, 'node-app'), { recursive: true })
  await fs.writeFile(path.join(root, 'node-app', 'package.json'), JSON.stringify({ name: 'x' }))
  await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true })
  await fs.mkdir(path.join(root, '.hidden'), { recursive: true })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('listNonProjectDirs', () => {
  it('lista apenas pastas sem git nem manifesto', async () => {
    const dirs = await listNonProjectDirs(root)
    expect(dirs.map((d) => d.name)).toEqual(['empty-folder'])
    expect(dirs[0].path).toBe(await fs.realpath(path.join(root, 'empty-folder')))
    expect(dirs[0].parentDir).toBe(path.basename(root))
  })

  it('retorna vazio para raiz inexistente', async () => {
    expect(await listNonProjectDirs(path.join(root, 'missing'))).toEqual([])
  })

  it('deduplica entre raízes sobrepostas', async () => {
    const dirs = await listAllNonProjectDirs([root, root])
    expect(dirs.map((d) => d.name)).toEqual(['empty-folder'])
  })
})
