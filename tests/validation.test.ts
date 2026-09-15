import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  testToolPath,
  validateCodexAccount,
  validateFiniteNumber,
  validateGitInitOptions,
  validateGitPushOptions,
  validateHttpsUrl,
  validateLaunchTool,
  validateProjectDirs,
  validateUsageTarget,
  validateWindowAction,
} from '../src/main/validation'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('IPC input validation', () => {
  it('accepts supported enum values and rejects values outside the allowlists', () => {
    expect(validateLaunchTool('codex-cli')).toBe('codex-cli')
    expect(validateCodexAccount('account2')).toBe('account2')
    expect(validateUsageTarget('antigravity')).toBe('antigravity')
    expect(validateWindowAction('maximize')).toBe('maximize')

    expect(() => validateLaunchTool('powershell')).toThrow('Ferramenta inválida')
    expect(() => validateCodexAccount('account3')).toThrow('Conta do Codex inválida')
    expect(() => validateUsageTarget('unknown')).toThrow('Alvo de uso inválido')
    expect(() => validateWindowAction('reload')).toThrow('Ação de janela inválida')
  })

  it('only accepts HTTPS URLs without embedded credentials', () => {
    expect(validateHttpsUrl('https://github.com/example/repo')).toBe('https://github.com/example/repo')
    expect(validateHttpsUrl('  HTTPS://GitHub.com/example/repo  ')).toBe(
      'https://github.com/example/repo'
    )

    expect(() => validateHttpsUrl('http://github.com/example/repo')).toThrow(
      'A URL deve usar HTTPS'
    )
    expect(() => validateHttpsUrl('https://user:password@example.com/repo')).toThrow(
      'não pode conter credenciais'
    )
    expect(() => validateHttpsUrl('javascript:alert(1)')).toThrow('A URL deve usar HTTPS')
    expect(() => validateHttpsUrl('not a URL')).toThrow('URL inválida')
  })

  it('validates Git initialization options before they reach the main process', () => {
    expect(validateGitInitOptions({
      branch: 'feature/conta-segura',
      remoteUrl: 'https://github.com/example/repo.git',
      initialCommit: true,
      commitMessage: 'chore: inicia projeto',
      push: true,
      confirmAllFiles: true,
      previewFingerprint: 'A'.repeat(64),
    })).toMatchObject({
      branch: 'feature/conta-segura',
      remoteUrl: 'https://github.com/example/repo.git',
      initialCommit: true,
      push: true,
      confirmAllFiles: true,
      previewFingerprint: 'a'.repeat(64),
    })

    expect(() => validateGitInitOptions({ branch: 'main && whoami' })).toThrow(
      'Nome de branch inválido'
    )
    expect(() => validateGitInitOptions({ push: true })).not.toThrow()
    expect(() => validateGitInitOptions({ commitMessage: '' })).toThrow(
      'Mensagem do commit inválida'
    )
  })

  it('validates and deduplicates explicitly selected Git push paths', () => {
    expect(validateGitPushOptions({ selectedPaths: ['src/app.ts', 'README.md', 'src/app.ts'] }))
      .toEqual({ selectedPaths: ['src/app.ts', 'README.md'] })
    expect(validateGitPushOptions(undefined)).toEqual({})
    expect(() => validateGitPushOptions({ selectedPaths: ['../outside'] })).toThrow('Caminho de arquivo')
    expect(() => validateGitPushOptions({ selectedPaths: [''] })).toThrow('Caminho de arquivo')
    expect(() => validateGitPushOptions({ selectedPaths: ['a\0b'] })).toThrow('Caminho de arquivo')
  })

  it('rejects non-finite and out-of-range numeric values', () => {
    expect(validateFiniteNumber(3, 'Limite')).toBe(3)
    expect(validateFiniteNumber(2, 'Quantidade', { minimum: 1, integer: true })).toBe(2)

    expect(() => validateFiniteNumber(Number.NaN, 'Limite')).toThrow('Limite inválido')
    expect(() => validateFiniteNumber(Number.POSITIVE_INFINITY, 'Limite')).toThrow('Limite inválido')
    expect(() => validateFiniteNumber(-1, 'Limite')).toThrow('Limite inválido')
    expect(() => validateFiniteNumber(1.5, 'Quantidade', { integer: true })).toThrow(
      'Quantidade inválido'
    )
  })

  it('canonicalizes project directories and removes duplicate paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-validation-'))
    temporaryDirectories.push(root)
    const projects = path.join(root, 'projects')
    await fs.mkdir(projects)

    const result = await validateProjectDirs([
      projects,
      path.join(root, 'nested', '..', 'projects'),
    ])

    expect(result).toHaveLength(1)
    expect(await fs.realpath(projects)).toBe(result[0])
  })

  it('checks tool paths against the filesystem and PATH', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-validation-'))
    temporaryDirectories.push(root)
    const exe = path.join(root, 'tool.exe')
    await fs.writeFile(exe, 'fixture')

    const found = await testToolPath(exe)
    expect(found).toMatchObject({ path: exe, ok: true })

    const missing = await testToolPath(path.join(root, 'missing.exe'))
    expect(missing).toMatchObject({ path: path.join(root, 'missing.exe'), ok: false })

    const unknownCommand = await testToolPath('definitely-not-a-real-command-xyz')
    expect(unknownCommand.ok).toBe(false)

    await expect(testToolPath('')).rejects.toThrow('inválido')
    await expect(testToolPath('a\0b')).rejects.toThrow('inválido')
  })

  it('rejects missing, file, and overlong project directory entries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-validation-'))
    temporaryDirectories.push(root)
    const file = path.join(root, 'not-a-directory.txt')
    await fs.writeFile(file, 'fixture')

    await expect(validateProjectDirs([path.join(root, 'missing')])).rejects.toThrow(
      'não existe ou não é uma pasta'
    )
    await expect(validateProjectDirs([file])).rejects.toThrow(
      'não existe ou não é uma pasta'
    )
    await expect(validateProjectDirs(Array.from({ length: 17 }, () => root))).rejects.toThrow(
      'no máximo 16 pastas'
    )
  })
})
