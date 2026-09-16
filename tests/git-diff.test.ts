import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getGitFileDiff, validateGitDiffPathspec } from '../src/main/git-diff'

const execFileAsync = promisify(execFile)

let repoPath = ''

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoPath, timeout: 10000, windowsHide: true })
  return stdout
}

beforeEach(async () => {
  repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-gitdiff-'))
  await git(['init', '--initial-branch', 'main'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'Test'])
  await fs.writeFile(path.join(repoPath, 'app.txt'), 'linha 1\nlinha 2\n')
  await git(['add', '-A'])
  await git(['commit', '-m', 'init'])
})

afterEach(async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(repoPath, { recursive: true, force: true })
      break
    } catch (error) {
      if (attempt === 4) break
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
})

describe('validateGitDiffPathspec', () => {
  it('aceita caminho relativo simples', () => {
    expect(validateGitDiffPathspec('src/app.ts')).toBe('src/app.ts')
  })

  it('rejeita traversal, absoluto e glob', () => {
    expect(() => validateGitDiffPathspec('../outside.txt')).toThrow('diff inválido')
    expect(() => validateGitDiffPathspec('/etc/passwd')).toThrow('diff inválido')
    expect(() => validateGitDiffPathspec('C:\\win\\file.txt')).toThrow('diff inválido')
    expect(() => validateGitDiffPathspec('src/*.ts')).toThrow('diff inválido')
    expect(() => validateGitDiffPathspec('-evil')).toThrow('diff inválido')
    expect(() => validateGitDiffPathspec('a\0b')).toThrow('diff inválido')
    expect(() => validateGitDiffPathspec('')).toThrow('diff inválido')
  })
})

describe('getGitFileDiff', () => {
  it('retorna HEAD e working tree lado a lado para arquivo modificado', async () => {
    await fs.writeFile(path.join(repoPath, 'app.txt'), 'linha 1\nlinha 2 alterada\nlinha 3 nova\n')
    const result = await getGitFileDiff(repoPath, 'app.txt')

    expect(result.path).toBe('app.txt')
    expect(result.headExists).toBe(true)
    expect(result.worktreeExists).toBe(true)
    expect(result.binary).toBe(false)
    expect(result.headContent).toContain('linha 1')
    expect(result.worktreeContent).toContain('linha 2 alterada')
    expect(result.diff).toContain('linha 2 alterada')
    expect(result.message).toBeTruthy()
  })

  it('sintetiza diff para arquivo untracked', async () => {
    await fs.writeFile(path.join(repoPath, 'novo.txt'), 'conteúdo novo\n')
    const result = await getGitFileDiff(repoPath, 'novo.txt')

    expect(result.headExists).toBe(false)
    expect(result.worktreeExists).toBe(true)
    expect(result.worktreeContent).toContain('conteúdo novo')
    expect(result.diff).toContain('+conteúdo novo')
  })

  it('rejeita pathspec inseguro sem executar git', async () => {
    await expect(getGitFileDiff(repoPath, '../outside.txt')).rejects.toThrow('diff inválido')
    await expect(getGitFileDiff(repoPath, 'src/*.ts')).rejects.toThrow('diff inválido')
  })

  it('recusa pasta que não é repositório', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-plain-'))
    try {
      await expect(getGitFileDiff(plain, 'app.txt')).rejects.toThrow('não é um repositório')
    } finally {
      await fs.rm(plain, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('marca binário sem vazar bytes', async () => {
    await fs.writeFile(path.join(repoPath, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x41, 0x42]))
    const result = await getGitFileDiff(repoPath, 'blob.bin')

    expect(result.binary).toBe(true)
    expect(result.diff).toBe('')
    expect(result.message).toMatch(/binário/i)
  })

  it('rejeita symlink dentro do repo sem seguir o alvo', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-outside-'))
    const secret = path.join(outside, 'secret.txt')
    await fs.writeFile(secret, 'segredo fora da raiz\n')
    const link = path.join(repoPath, 'atalho.txt')
    try {
      await fs.symlink(secret, link, 'file')
    } catch {
      await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined)
      return
    }
    try {
      await expect(getGitFileDiff(repoPath, 'atalho.txt')).rejects.toThrow(/simbólico|diff inválido/i)
    } finally {
      await fs.rm(link, { force: true }).catch(() => undefined)
      await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('sintetiza working tree em repo sem HEAD sem exibir fatal', async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-nohead-'))
    try {
      const run = promisify(execFile)
      await run('git', ['init', '--initial-branch', 'main'], { cwd: fresh })
      await fs.writeFile(path.join(fresh, 'rascunho.txt'), 'primeira linha\nsegunda linha\n')
      const result = await getGitFileDiff(fresh, 'rascunho.txt')

      expect(result.headExists).toBe(false)
      expect(result.worktreeExists).toBe(true)
      expect(result.worktreeContent).toContain('primeira linha')
      expect(result.diff).toContain('+primeira linha')
      expect(result.diff).not.toMatch(/fatal|bad revision/i)
    } finally {
      await fs.rm(fresh, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
