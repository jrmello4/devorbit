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
    expect(safe.secretsSessionOnly).toBeUndefined()
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

  it('safeStorage indisponível: nada é gravado em disco e a chave fica session-only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    electronState.encryptionAvailable = false

    const saved = await saveConfig({ modelRouting: { fastModel: 'gpt-mini', vllmApiKey: SECRET } })
    expect(saved.modelRouting?.vllmApiKey).toBe(SECRET)

    // (a) Nada persistido: sem cofre novo, sem `encrypted:false`, sem segredo.
    await expect(fs.readFile(secretStoreFilePath(), 'utf-8')).rejects.toThrow()
    const persisted = JSON.parse(await fs.readFile(configFilePath(), 'utf-8'))
    expect(persisted.modelRouting).toMatchObject({ fastModel: 'gpt-mini' })
    expect(JSON.stringify(persisted)).not.toContain(SECRET)
    expect(JSON.stringify(persisted)).not.toContain('vllmApiKey')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Armazenamento seguro'))

    // (b) Utilizável em memória na mesma sessão.
    expect((await loadConfig()).modelRouting?.vllmApiKey).toBe(SECRET)

    // (c) Sinal exposto ao renderer sem revelar o valor.
    const safe = toSafeConfig(await loadConfig())
    expect(safe.modelRouting?.hasVllmKey).toBe(true)
    expect(safe.secretsSessionOnly).toBe(true)
    expect(JSON.stringify(safe)).not.toContain(SECRET)
  })

  it('safeStorage indisponível: edições seguintes mantêm as credenciais da sessão', async () => {
    electronState.encryptionAvailable = false
    await saveConfig({ modelRouting: { vllmApiKey: SECRET } })
    await saveConfig({ modelRouting: { kimiApiKey: GEMINI_SECRET } })

    const loaded = await loadConfig()
    expect(loaded.modelRouting?.vllmApiKey).toBe(SECRET)
    expect(loaded.modelRouting?.kimiApiKey).toBe(GEMINI_SECRET)
    await expect(fs.readFile(secretStoreFilePath(), 'utf-8')).rejects.toThrow()
  })

  it('safeStorage indisponível: remover a chave da sessão a apaga da memória', async () => {
    electronState.encryptionAvailable = false
    await saveConfig({ modelRouting: { vllmApiKey: SECRET } })

    const cleared = await saveConfig({ modelRouting: { vllmApiKey: '' } })
    expect(cleared.modelRouting?.vllmApiKey).toBeUndefined()
    expect((await loadConfig()).modelRouting?.vllmApiKey).toBeUndefined()
    await expect(fs.readFile(secretStoreFilePath(), 'utf-8')).rejects.toThrow()
  })

  it('legado plaintext no config.json: indisponível preserva o arquivo e usa a chave em memória', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const legacyConfig = JSON.stringify({ modelRouting: { fastModel: 'legacy', deepseekApiKey: SECRET } })
    await fs.writeFile(configFilePath(), legacyConfig)
    electronState.encryptionAvailable = false

    // (d) Migração adiada: o texto claro NÃO é reescrito nem apagado e a
    // chave continua utilizável em memória nesta sessão.
    const loaded = await loadConfig()
    expect(loaded.modelRouting?.deepseekApiKey).toBe(SECRET)
    expect(loaded.modelRouting?.fastModel).toBe('legacy')
    expect(await fs.readFile(configFilePath(), 'utf-8')).toBe(legacyConfig)
    await expect(fs.readFile(secretStoreFilePath(), 'utf-8')).rejects.toThrow()
    expect(toSafeConfig(loaded).secretsSessionOnly).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Armazenamento seguro'))

    // (e) Com o safeStorage de volta, a migração normal acontece.
    electronState.encryptionAvailable = true
    const migrated = await loadConfig()
    expect(migrated.modelRouting?.deepseekApiKey).toBe(SECRET)
    expect(await fs.readFile(configFilePath(), 'utf-8')).not.toContain(SECRET)
    const store = JSON.parse(await fs.readFile(secretStoreFilePath(), 'utf-8'))
    expect(store.encrypted).toBe(true)
  })

  it('cofre plaintext legado (encrypted:false): indisponível não o reescreve; disponível re-cifra', async () => {
    const legacyStore = JSON.stringify({ version: 1, encrypted: false, data: { vllmApiKey: SECRET } })
    await fs.writeFile(secretStoreFilePath(), legacyStore)
    electronState.encryptionAvailable = false

    const loaded = await loadConfig()
    expect(loaded.modelRouting?.vllmApiKey).toBe(SECRET)
    expect(await fs.readFile(secretStoreFilePath(), 'utf-8')).toBe(legacyStore)

    electronState.encryptionAvailable = true
    const migrated = await loadConfig()
    expect(migrated.modelRouting?.vllmApiKey).toBe(SECRET)
    const store = JSON.parse(await fs.readFile(secretStoreFilePath(), 'utf-8'))
    expect(store.encrypted).toBe(true)
    expect(JSON.stringify(store)).not.toContain(SECRET)
  })

  it('safeStorage indisponível: save de outros campos succeeds e preserva o legado não tocado', async () => {
    await fs.writeFile(
      configFilePath(),
      JSON.stringify({ chatGptAccount1Name: 'Antiga', modelRouting: { deepseekApiKey: SECRET } })
    )
    electronState.encryptionAvailable = false

    const saved = await saveConfig({ chatGptAccount1Name: 'Nova' })
    expect(saved.chatGptAccount1Name).toBe('Nova')
    expect(saved.modelRouting?.deepseekApiKey).toBe(SECRET)

    const persisted = JSON.parse(await fs.readFile(configFilePath(), 'utf-8'))
    expect(persisted.chatGptAccount1Name).toBe('Nova')
    expect(persisted.modelRouting.deepseekApiKey).toBe(SECRET)
    await expect(fs.readFile(secretStoreFilePath(), 'utf-8')).rejects.toThrow()
  })

  it('safeStorage indisponível: remover chave legada limpa o texto claro do config.json', async () => {
    await fs.writeFile(configFilePath(), JSON.stringify({ modelRouting: { deepseekApiKey: SECRET } }))
    electronState.encryptionAvailable = false

    const cleared = await saveConfig({ modelRouting: { deepseekApiKey: '' } })
    expect(cleared.modelRouting?.deepseekApiKey).toBeUndefined()
    expect((await loadConfig()).modelRouting?.deepseekApiKey).toBeUndefined()
    expect(await fs.readFile(configFilePath(), 'utf-8')).not.toContain('deepseekApiKey')
    await expect(fs.readFile(secretStoreFilePath(), 'utf-8')).rejects.toThrow()
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
