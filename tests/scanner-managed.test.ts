import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { scanAllProjects } from '../src/main/scanner'

let root = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-managed-'))
  await fs.mkdir(path.join(root, 'empty-project'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('managed project catalog', () => {
  it('keeps an empty working folder as an archived project', async () => {
    const projects = await scanAllProjects([root], false, [{
      id: 'managed-1',
      name: 'empty-project',
      parentPath: root,
      folderName: 'empty-project',
      remoteUrl: 'https://github.com/example/empty-project.git',
      branch: 'main',
      registeredAt: new Date().toISOString(),
    }])

    expect(projects).toHaveLength(1)
    expect(projects.find((project) => project.name === 'empty-project')?.lifecycle).toBe('archived')
    expect(projects[0].remoteUrl).toContain('github.com/example')
    expect(projects[0].git.statusMessage).toMatch(/arquivado/i)
  })

  it('marks a scanned empty project as archived after its Git folder was removed', async () => {
    const projectsRoot = path.join(root, 'projects')
    await fs.mkdir(projectsRoot)
    await fs.mkdir(path.join(projectsRoot, 'released'))
    const projects = await scanAllProjects([projectsRoot], false, [{
      id: 'managed-2',
      name: 'released',
      parentPath: projectsRoot,
      folderName: 'released',
      remoteUrl: 'https://github.com/example/released.git',
      branch: 'main',
      registeredAt: new Date().toISOString(),
    }])

    expect(projects.find((project) => project.name === 'released')?.lifecycle).toBe('archived')
  })
  it('summarizes package manager and useful scripts', async () => {
    const projectPath = path.join(root, 'node-project')
    await fs.mkdir(projectPath)
    await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@9.0.0',
      scripts: { dev: 'vite', build: 'vite build', lint: 'eslint .' },
      dependencies: { react: '^19.0.0' },
    }))
    await fs.writeFile(path.join(projectPath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')

    const projects = await scanAllProjects([root])
    const project = projects.find((entry) => entry.name === 'node-project')

    expect(project?.packageManager).toBe('pnpm')
    expect(project?.scripts).toEqual(['dev', 'build', 'lint'])
  })
})
