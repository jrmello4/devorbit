import { describe, expect, it } from 'vitest'
import { buildAiMemoryHelperEnv } from '../src/main/ai-memory-process-env'

const BASE: NodeJS.ProcessEnv = {
  PATH: 'C:\\Windows;C:\\bin',
  Path: 'C:\\Windows;C:\\bin',
  SystemRoot: 'C:\\Windows',
  windir: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  TEMP: 'C:\\Temp',
  HOME: '/home/dev',
  TMPDIR: '/tmp',
  OPENAI_API_KEY: 'sk-openai-secret',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  GEMINI_API_KEY: 'sk-gemini-secret',
  DEVORBIT_BRIDGE_TOKEN: 'bridge-token',
  ACCESS_TOKEN: 'access-token',
  MY_CLIENT_SECRET: 'client-secret',
  CODEX_HOME: 'C:\\Users\\dev\\.codex-conta2',
}

describe('buildAiMemoryHelperEnv — allowlist mínima para helpers', () => {
  it('remove credenciais e preserva PATH/SystemRoot/TEMP/ComSpec/HOME', () => {
    const env = buildAiMemoryHelperEnv({ base: BASE })

    expect(env.PATH).toBe('C:\\Windows;C:\\bin')
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.windir).toBe('C:\\Windows')
    expect(env.ComSpec).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(env.TEMP).toBe('C:\\Temp')
    expect(env.HOME).toBe('/home/dev')
    expect(env.TMPDIR).toBe('/tmp')

    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.GEMINI_API_KEY).toBeUndefined()
    expect(env.DEVORBIT_BRIDGE_TOKEN).toBeUndefined()
    expect(env.ACCESS_TOKEN).toBeUndefined()
    expect(env.MY_CLIENT_SECRET).toBeUndefined()
  })

  it('não inclui CODEX_HOME por padrão (nem mesmo vindo da base)', () => {
    const env = buildAiMemoryHelperEnv({ base: BASE })
    expect(env.CODEX_HOME).toBeUndefined()
    expect(Object.keys(env).some((key) => key.toLowerCase() === 'codex_home')).toBe(false)
  })

  it('inclui CODEX_HOME da base apenas com allowCodexHome', () => {
    const env = buildAiMemoryHelperEnv({ base: BASE, allowCodexHome: true })
    expect(env.CODEX_HOME).toBe('C:\\Users\\dev\\.codex-conta2')
  })

  it('preserva o CAMINHO de CODEX_HOME vindo do overlay somente com allowCodexHome', () => {
    const withPath = buildAiMemoryHelperEnv({
      base: BASE,
      overlay: { CODEX_HOME: 'C:\\Users\\dev\\.codex-conta1' },
      allowCodexHome: true,
    })
    expect(withPath.CODEX_HOME).toBe('C:\\Users\\dev\\.codex-conta1')

    const withoutPermission = buildAiMemoryHelperEnv({
      base: BASE,
      overlay: { CODEX_HOME: 'C:\\Users\\dev\\.codex-conta1' },
    })
    expect(withoutPermission.CODEX_HOME).toBeUndefined()
  })

  it('aceita overlay não-secreto e descarta overlay secreto', () => {
    const env = buildAiMemoryHelperEnv({
      base: BASE,
      overlay: { DEVORBIT_MODEL: 'gpt-4o-mini', OPENAI_API_KEY: 'sk-injected' },
    })
    expect(env.DEVORBIT_MODEL).toBe('gpt-4o-mini')
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })

  it('match de allowlist é case-insensitive (Path vs PATH)', () => {
    const env = buildAiMemoryHelperEnv({ base: { Path: 'C:\\only' } })
    expect(env.Path).toBe('C:\\only')
  })

  it('não vaza variáveis DEVORBIT_* arbitrárias da base', () => {
    const env = buildAiMemoryHelperEnv({ base: { ...BASE, DEVORBIT_SESSION_ID: 'sess', DEVORBIT_BRIDGE_PIPE: '\\\\.\\pipe\\x' } })
    expect(env.DEVORBIT_SESSION_ID).toBeUndefined()
    expect(env.DEVORBIT_BRIDGE_PIPE).toBeUndefined()
  })
})
