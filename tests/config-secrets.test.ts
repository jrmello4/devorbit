import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const electronState = vi.hoisted(() => ({
  userDataPath: '',
  encryptionAvailable: false,
}))

vi.mock('electron', () => ({
  default: {
    app: {
      getPath: () => electronState.userDataPath,
    },
    safeStorage: {
      isEncryptionAvailable: () => electronState.encryptionAvailable,
      encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value: Buffer) => value.toString('utf8').replace(/^enc:/, ''),
    },
  },
}))

import {
  exportConfigJson,
  importConfigJson,
  loadConfig,
  saveConfig,
  toSafeConfig,
  validateConfigUpdatesForSave,
} from '../src/main/config'

const SECRET = `sk-deep-${'a'.repeat(24)}`
const GEMINI_SECRET = `AIza-${'b'.repeat(24)}`
let temporaryUserData = ''

beforeEach(async () => {
  temporaryUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-secrets-'))
  electronState.userDataPath = temporaryUserData
  electronState.encryptionAvailable = true
})

afterEach(async () => {
  await fs.rm(temporaryUserData, { recursive: true, force: true })
})

function configFilePath(): string {
  return path.join(temporaryUserData, 'config.json')
}

function secretStoreFilePath(): string {
  return path.join(temporaryUserData, 'config-secrets.json')
}

async function waitFor(check: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await check()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  await check()
}

describe('config — armazenamento seguro de credenciais BYOK', () => {
  it('cifra a chave no disco e nunca a expõe na projeção do renderer', async () => {
    const saved = await saveConfig({
      modelRouting: { fastModel: 'gpt-4o-mini', deepseekApiKey: SECRET, geminiApiKey: GEMINI_SECRET },
    })
    expect(saved.modelRouting?.deepseekApiKey).toBe(SECRET)
    expect(saved.modelRouting?.geminiApiKey).toBe(GEMINI_SECRET)

    const persistedConfig = await fs.readFile(configFilePath(), 'utf-8')
    expect(persistedConfig).not.toContain(SECRET)
    expect(persistedConfig).not.toContain(GEMINI_SECRET)
    expect(persistedConfig).not.toContain('deepseekApiKey')

    const store = JSON.parse(await fs.readFile(secretStoreFilePath(), 'utf-8'))
    expect(store.encrypted).toBe(true)
    expect(store.data).not.toContain(SECRET)

    const loaded = await loadConfig()
    expect(loaded.modelRouting?.deepseekApiKey).toBe(SECRET)
    expect(loaded.modelRouting?.geminiApiKey).toBe(GEMINI_SECRET)

    const safe = toSafeConfig(loaded)
    expect(safe.modelRouting?.hasDeepseekKey).toBe(true)
    expect(safe.modelRouting?.hasGeminiKey).toBe(true)
    expect(safe.modelRouting).not.toHaveProperty('deepseekApiKey')
    expect(safe.modelRouting).not.toHaveProperty('geminiApiKey')
    expect(JSON.stringify(safe)).not.toContain(SECRET)
    expect(JSON.stringify(safe)).not.toContain(GEMINI_SECRET)
  })

  it('exporta sem segredos e reimporta apenas os campos públicos', async () => {
    await saveConfig({ modelRouting: { fastModel: 'm1', deepseekApiKey: SECRET } })

    const exported = await exportConfigJson()
    expect(exported).not.toContain(SECRET)
    expect(JSON.parse(exported).modelRouting.hasDeepseekKey).toBe(true)

    const imported = await importConfigJson(exported)
    expect(imported.modelRouting?.fastModel).toBe('m1')
    expect((await loadConfig()).modelRouting?.deepseekApiKey).toBe(SECRET)
  })

  it('migra chaves em texto claro do config.json para o store cifrado', async () => {
    await fs.writeFile(
      configFilePath(),
      JSON.stringify({ modelRouting: { fastModel: 'legacy', deepseekApiKey: SECRET } })
    )

    const loaded = await loadConfig()
    expect(loaded.modelRouting?.deepseekApiKey).toBe(SECRET)
    expect(loaded.modelRouting?.fastModel).toBe('legacy')

    await waitFor(async () => {
      const persisted = await fs.readFile(configFilePath(), 'utf-8')
      expect(persisted).not.toContain(SECRET)
    })
    const store = JSON.parse(await fs.readFile(secretStoreFilePath(), 'utf-8'))
    expect(store.encrypted).toBe(true)
  })

  it('remove a credencial quando o renderer envia string vazia', async () => {
    await saveConfig({ modelRouting: { deepseekApiKey: SECRET } })

    const cleared = await saveConfig({ modelRouting: { deepseekApiKey: '' } })
    expect(cleared.modelRouting?.deepseekApiKey).toBeUndefined()
    expect((await loadConfig()).modelRouting?.deepseekApiKey).toBeUndefined()
    await expect(fs.readFile(secretStoreFilePath(), 'utf-8')).rejects.toThrow()
  })

  it('usa fallback sem criptografia, avisa e mantém o renderer seguro', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    electronState.encryptionAvailable = false

    await saveConfig({ modelRouting: { vllmApiKey: SECRET } })

    const store = JSON.parse(await fs.readFile(secretStoreFilePath(), 'utf-8'))
    expect(store.encrypted).toBe(false)
    expect(store.data.vllmApiKey).toBe(SECRET)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Armazenamento seguro'))

    const safe = toSafeConfig(await loadConfig())
    expect(safe.modelRouting?.hasVllmKey).toBe(true)
    expect(JSON.stringify(safe)).not.toContain(SECRET)
  })

  it('preserva o cofre cifrado e bloqueia edição quando safeStorage fica indisponível', async () => {
    await saveConfig({ modelRouting: { deepseekApiKey: SECRET } })
    const encryptedStore = await fs.readFile(secretStoreFilePath(), 'utf-8')

    electronState.encryptionAvailable = false
    const loaded = await loadConfig()
    expect(loaded.modelRouting?.deepseekApiKey).toBeUndefined()

    await expect(saveConfig({ modelRouting: { deepseekApiKey: 'sk-other-key' } })).rejects.toThrow(
      'Armazenamento seguro indisponível'
    )
    expect(await fs.readFile(secretStoreFilePath(), 'utf-8')).toBe(encryptedStore)
  })

  it('valida URLs base por provedor e aceita loopback HTTP', async () => {
    await expect(
      validateConfigUpdatesForSave({ modelRouting: { deepseekBaseUrl: 'http://evil.example' } })
    ).rejects.toThrow()

    const accepted = await validateConfigUpdatesForSave({
      modelRouting: { vllmBaseUrl: 'http://127.0.0.1:8000/v1' },
    })
    expect(accepted.modelRouting?.vllmBaseUrl).toBe('http://127.0.0.1:8000/v1')
  })

  it('grava o cofre antes de remover o texto claro: falha não apaga o segredo', async () => {
    await fs.writeFile(
      configFilePath(),
      JSON.stringify({ modelRouting: { fastModel: 'legacy', deepseekApiKey: SECRET } })
    )
    // Diretório no lugar do cofre: writeSecretStore falha deterministicamente.
    await fs.mkdir(secretStoreFilePath(), { recursive: true })

    await expect(loadConfig()).rejects.toThrow()

    const persisted = await fs.readFile(configFilePath(), 'utf-8')
    expect(persisted).toContain(SECRET)
    expect(JSON.parse(persisted).modelRouting.deepseekApiKey).toBe(SECRET)
  })

  it('migra sob concorrência sem perder segredo', async () => {
    await fs.writeFile(
      configFilePath(),
      JSON.stringify({ modelRouting: { fastModel: 'legacy', deepseekApiKey: SECRET } })
    )

    const [first, second] = await Promise.all([loadConfig(), loadConfig()])
    expect(first.modelRouting?.deepseekApiKey).toBe(SECRET)
    expect(second.modelRouting?.deepseekApiKey).toBe(SECRET)

    const persisted = await fs.readFile(configFilePath(), 'utf-8')
    expect(persisted).not.toContain(SECRET)
    expect(persisted).not.toContain('deepseekApiKey')

    const store = JSON.parse(await fs.readFile(secretStoreFilePath(), 'utf-8'))
    expect(store.encrypted).toBe(true)
    expect((await loadConfig()).modelRouting?.deepseekApiKey).toBe(SECRET)
  })

  it('falha do cofre em save não-secreto mantém o segredo legado e não aplica o campo', async () => {
    await fs.writeFile(
      configFilePath(),
      JSON.stringify({ chatGptAccount1Name: 'Antigo', modelRouting: { fastModel: 'legacy', deepseekApiKey: SECRET } })
    )
    // Diretório no lugar do cofre: a escrita do cofre falha deterministicamente.
    await fs.mkdir(secretStoreFilePath(), { recursive: true })

    await expect(saveConfig({ chatGptAccount1Name: 'Novo' })).rejects.toThrow()

    const persisted = JSON.parse(await fs.readFile(configFilePath(), 'utf-8'))
    expect(persisted.modelRouting.deepseekApiKey).toBe(SECRET)
    expect(persisted.chatGptAccount1Name).toBe('Antigo')
  })

  it('save não-secreto e load concorrentes não perdem o segredo legado', async () => {
    await fs.writeFile(
      configFilePath(),
      JSON.stringify({ chatGptAccount1Name: 'Antigo', modelRouting: { deepseekApiKey: SECRET } })
    )

    const [saved] = await Promise.all([
      saveConfig({ chatGptAccount1Name: 'Concorrente' }),
      loadConfig(),
    ])
    expect(saved.chatGptAccount1Name).toBe('Concorrente')

    const persisted = await fs.readFile(configFilePath(), 'utf-8')
    expect(persisted).not.toContain(SECRET)
    expect(persisted).not.toContain('deepseekApiKey')

    const loaded = await loadConfig()
    expect(loaded.chatGptAccount1Name).toBe('Concorrente')
    expect(loaded.modelRouting?.deepseekApiKey).toBe(SECRET)
  })

  it('remove URL base com string vazia explícita antes de normalizar', async () => {
    await saveConfig({ modelRouting: { deepseekBaseUrl: 'https://gateway.example/v1' } })
    expect((await loadConfig()).modelRouting?.deepseekBaseUrl).toBe('https://gateway.example/v1')

    const cleared = await saveConfig({ modelRouting: { deepseekBaseUrl: '' } })
    expect(cleared.modelRouting?.deepseekBaseUrl).toBeUndefined()
    expect((await loadConfig()).modelRouting?.deepseekBaseUrl).toBeUndefined()
    expect(await fs.readFile(configFilePath(), 'utf-8')).not.toContain('deepseekBaseUrl')

    // Mesmo caminho usado pelo IPC (validação antes de salvar).
    await saveConfig({ modelRouting: { deepseekBaseUrl: 'https://gateway.example/v2' } })
    await saveConfig(await validateConfigUpdatesForSave({ modelRouting: { deepseekBaseUrl: '' } }))
    expect((await loadConfig()).modelRouting?.deepseekBaseUrl).toBeUndefined()
  })
})
