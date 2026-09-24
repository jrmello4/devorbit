import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = vi.hoisted(() => ({ value: '', throwOnGet: false }))

vi.mock('electron', () => ({
  default: {
    app: {
      getPath: () => {
        if (userData.throwOnGet) throw new Error('userData indisponível')
        return userData.value
      },
    },
  },
}))

import { loadAiMemoryConfig, saveAiMemoryConfig, setAiMemoryProjectEnabled } from '../src/main/config'

let temporaryUserData = ''

beforeEach(async () => {
  temporaryUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-aimem-config-'))
  userData.value = temporaryUserData
  userData.throwOnGet = false
})

afterEach(async () => {
  await fs.rm(temporaryUserData, { recursive: true, force: true })
})

const validProject = {
  identity: 'remote:abc',
  workspace: 'devorbit',
  project: 'p-123',
  path: 'C:\\repo',
  enabled: true,
}

describe('ai-memory config consent', () => {
  it('arquivo ausente devolve default desabilitado', async () => {
    await expect(loadAiMemoryConfig()).resolves.toEqual({ enabled: false, projects: {} })
  })

  it('userData indisponível é reportado, sem fallback para outro home', async () => {
    userData.throwOnGet = true
    await expect(loadAiMemoryConfig()).rejects.toThrow(/userData/)
    await expect(saveAiMemoryConfig({ enabled: true })).rejects.toThrow(/userData/)
  })

  it('JSON corrompido é reportado como falha', async () => {
    await fs.mkdir(path.join(temporaryUserData, 'ai-memory'), { recursive: true })
    await fs.writeFile(path.join(temporaryUserData, 'ai-memory', 'config.json'), '{ not json', 'utf-8')
    await expect(loadAiMemoryConfig()).rejects.toThrow(/JSON corrompido/)
  })

  it('config default é desabilitado até opt-in explícito', async () => {
    const config = await loadAiMemoryConfig()
    expect(config.enabled).toBe(false)
    expect(Object.keys(config.projects)).toHaveLength(0)
  })

  it('habilitar projeto via setAiMemoryProjectEnabled liga o gate global no mesmo update', async () => {
    const saved = await setAiMemoryProjectEnabled(validProject, true)
    // Bug fix: enabled deve ser true no mesmo update que habilita o projeto,
    // senão o sidecar não sobe (default disabled impedia startup).
    expect(saved.enabled).toBe(true)
    expect(saved.projects['remote:abc']).toMatchObject({ workspace: 'devorbit', project: 'p-123', enabled: true })

    const reloaded = await loadAiMemoryConfig()
    expect(reloaded.enabled).toBe(true)
    expect(reloaded.projects['remote:abc'].enabled).toBe(true)
  })

  it('desabilitar projeto NÃO desliga o gate global (controle explícito do usuário)', async () => {
    await setAiMemoryProjectEnabled(validProject, true)
    const afterEnable = await loadAiMemoryConfig()
    expect(afterEnable.enabled).toBe(true)

    const afterDisable = await setAiMemoryProjectEnabled(validProject, false)
    // Gate global permanece true; o usuário controla via saveAiMemoryConfig({ enabled: false })
    expect(afterDisable.enabled).toBe(true)
    expect(afterDisable.projects['remote:abc'].enabled).toBe(false)
  })

  it('desabilitar o último projeto é seguro (sidecar fica no-op, gate preservado)', async () => {
    await setAiMemoryProjectEnabled(validProject, true)
    await setAiMemoryProjectEnabled(validProject, false)
    const config = await loadAiMemoryConfig()
    expect(config.enabled).toBe(true)
    expect(config.projects['remote:abc'].enabled).toBe(false)
  })

  it('descarta projeto com nome/escopo inválidos', async () => {
    const saved = await saveAiMemoryConfig({
      projects: {
        bad: { identity: 'x', workspace: 'INVALID SPACE', project: 'p', path: 'C:\\r', enabled: true },
      },
    })
    expect(saved.projects).toEqual({})
  })
})
