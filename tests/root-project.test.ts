import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isPathWithinRoot } from '../src/main/validation'
import { scanDirectoryForProjects } from '../src/main/scanner'

const temporaryDirectories: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('scanDirectoryForProjects — projeto raiz direto', () => {
  it('inclui a própria pasta monitorada quando ela já é um projeto válido', async () => {
    const root = await makeTempDir('devorbit-root-project-')
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root-app' }))

    const projects = await scanDirectoryForProjects(root)
    const realRoot = await fs.realpath(root)
    const rootProject = projects.find((project) => project.path === realRoot)

    expect(rootProject).toBeDefined()
    expect(rootProject?.name).toBe(path.basename(realRoot))
    expect(rootProject?.techs.some((tech) => tech.id === 'nodejs')).toBe(true)
  })

  it('inclui raiz e subprojeto juntos sem duplicar o root', async () => {
    const root = await makeTempDir('devorbit-root-project-')
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root-app' }))
    const child = path.join(root, 'child-app')
    await fs.mkdir(child)
    await fs.writeFile(path.join(child, 'package.json'), JSON.stringify({ name: 'child-app' }))

    const projects = await scanDirectoryForProjects(root)
    const realRoot = await fs.realpath(root)
    const realChild = await fs.realpath(child)

    expect(projects.filter((project) => project.path === realRoot)).toHaveLength(1)
    expect(projects.some((project) => project.path === realChild)).toBe(true)
  })

  it('não transforma a pasta container em projeto quando não há sinal de projeto', async () => {
    const root = await makeTempDir('devorbit-root-plain-')
    await fs.mkdir(path.join(root, 'empty-folder'))

    const projects = await scanDirectoryForProjects(root)
    const realRoot = await fs.realpath(root)

    expect(projects.some((project) => project.path === realRoot)).toBe(false)
  })
})

describe('isPathWithinRoot — containment do IPC', () => {
  it('aceita candidate igual ao canonicalRoot (projeto raiz direto)', async () => {
    const root = await makeTempDir('devorbit-contain-')
    const canonicalRoot = await fs.realpath(root)

    expect(isPathWithinRoot(canonicalRoot, canonicalRoot)).toBe(true)
  })

  it('aceita descendentes legítimos', async () => {
    const root = await makeTempDir('devorbit-contain-')
    const child = path.join(root, 'app')
    await fs.mkdir(child)

    expect(isPathWithinRoot(await fs.realpath(child), await fs.realpath(root))).toBe(true)
  })

  it('rejeita irmãos, pai e travessia para fora da raiz', async () => {
    const root = await makeTempDir('devorbit-contain-')
    const sibling = await makeTempDir('devorbit-sibling-')
    const canonicalRoot = await fs.realpath(root)

    expect(isPathWithinRoot(await fs.realpath(sibling), canonicalRoot)).toBe(false)
    expect(isPathWithinRoot(path.dirname(canonicalRoot), canonicalRoot)).toBe(false)
    expect(isPathWithinRoot(path.join(canonicalRoot, '..', 'escape'), canonicalRoot)).toBe(false)
  })

  it('não confunde uma pasta com prefixo semelhante', () => {
    const root = process.platform === 'win32' ? 'C:\\safe\\app' : '/safe/app'
    const lookalike = process.platform === 'win32' ? 'C:\\safe\\app-other' : '/safe/app-other'

    expect(isPathWithinRoot(lookalike, root)).toBe(false)
  })
})
