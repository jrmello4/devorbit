import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  validateCodexAccount,
  validateFiniteNumber,
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
