import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_PROJECT_FILE_BYTES,
  listProjectFiles,
  readProjectFile,
  saveProjectFile,
} from '../src/main/project-files'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

async function createProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-files-'))
  temporaryDirectories.push(root)
  await fs.mkdir(path.join(root, 'src'))
  await fs.mkdir(path.join(root, 'node_modules'))
  await fs.mkdir(path.join(root, '.git'))
  await fs.writeFile(path.join(root, 'README.md'), '# DevOrbit\n')
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const answer = 42\n')
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.js'), 'ignored')
  await fs.writeFile(path.join(root, '.git', 'config'), 'ignored')
  return root
}

describe('project file workspace', () => {
  it('lists a bounded editable tree and ignores generated or private directories', async () => {
    const root = await createProject()
    const entries = await listProjectFiles(root)
    const paths = entries.entries.map((entry) => entry.path)

    expect(paths).toContain('README.md')
    expect(paths).toContain('src')
    expect(paths).not.toContain(path.join('src', 'index.ts'))
    expect(paths).not.toContain(path.join('node_modules', 'ignored.js'))
    expect(paths).not.toContain(path.join('.git', 'config'))
    expect(entries.entries.find((entry) => entry.path === 'README.md')).toMatchObject({
      kind: 'file',
      editable: true,
    })
    expect(entries.truncated).toBe(false)
  })

  it('lista os filhos de um diretório sob demanda', async () => {
    const root = await createProject()
    const entries = await listProjectFiles(root, 'src')

    expect(entries.entries.map((entry) => entry.path)).toEqual([path.join('src', 'index.ts')])
    expect(entries.truncated).toBe(false)
  })

  it('marca uma pasta quando a listagem atinge o limite por chamada', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-files-large-'))
    temporaryDirectories.push(root)
    await Promise.all(Array.from({ length: 601 }, (_, index) => (
      fs.writeFile(path.join(root, `file-${String(index).padStart(3, '0')}.txt`), 'x')
    )))

    const entries = await listProjectFiles(root)

    expect(entries.entries).toHaveLength(600)
    expect(entries.truncated).toBe(true)
  })

  it('reads and atomically saves a file inside the project', async () => {
    const root = await createProject()
    const loaded = await readProjectFile(root, path.join('src', 'index.ts'))
    expect(loaded.content).toContain('answer = 42')

    const saved = await saveProjectFile(root, path.join('src', 'index.ts'), 'export const answer = 43\n')
    expect(saved.content).toContain('43')
    await expect(readProjectFile(root, path.join('src', 'index.ts'))).resolves.toMatchObject({
      content: 'export const answer = 43\n',
    })
  })

  it('rejects traversal and keeps the size and text boundaries', async () => {
    const root = await createProject()
    await expect(readProjectFile(root, '..\\outside.txt')).rejects.toThrow('dentro do projeto')
    await expect(saveProjectFile(root, 'missing.ts', 'x')).rejects.toThrow()
    await expect(saveProjectFile(root, 'README.md', 'x'.repeat(MAX_PROJECT_FILE_BYTES + 1))).rejects.toThrow('1,5 MB')

    await fs.writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]))
    await expect(readProjectFile(root, 'invalid.txt')).rejects.toThrow('UTF-8')
  })
})
