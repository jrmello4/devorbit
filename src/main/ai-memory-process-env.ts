/**
 * Ambiente MÍNIMO para SUBPROCESSOS AUXILIARES do ai-memory
 * (service/sidecar, doctor, setup/MCP/hooks, finalize, migração).
 *
 * Motivação de segurança: os runners padrão herdavam `process.env` inteiro do
 * DevOrbit (BYOK/API keys, tokens de bridge, CODEX_HOME de sessão), embora
 * esses helpers não precisem de nenhuma credencial. Aqui a política é
 * ALLOWLIST: só variáveis de execução/OS sobrevivem; qualquer chave com cara
 * de segredo é removida por defesa em profundidade.
 *
 * FRONTEIRA (NÃO usar aqui): o contrato do `ai-memory run` (PTY interativo)
 * DEVE herdar a autenticação do harness e o `CODEX_HOME` do filho — esse
 * caminho continua passando o env do harness intacto e NÃO é filtrado por
 * este helper.
 */

export interface AiMemoryProcessEnvOptions {
  /** Base a filtrar; default = `process.env` (injetável em teste). */
  base?: NodeJS.ProcessEnv
  /** Overlay explícito do chamador (ex.: `CODEX_HOME` de perfil). */
  overlay?: NodeJS.ProcessEnv
  /**
   * Permite `CODEX_HOME` (somente hook/finalizer específico de Codex, que
   * precisa do caminho do perfil). NUNCA habilita cópia de tokens.
   */
  allowCodexHome?: boolean
}

/** Variáveis de execução/OS preservadas (comparadas case-insensitive). */
const BASE_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Execução / resolução de binários
  'path',
  'pathext',
  'comspec',
  'shell',
  // Sistema Windows
  'systemroot',
  'systemdrive',
  'windir',
  'os',
  'processor_architecture',
  'processor_identifier',
  'number_of_processors',
  'programdata',
  'programfiles',
  'programfiles(x86)',
  'commonprogramfiles',
  'commonprogramfiles(x86)',
  // Usuário / home
  'username',
  'userdomain',
  'userprofile',
  'homedrive',
  'homepath',
  'home',
  'appdata',
  'localappdata',
  // Temporários / locale
  'temp',
  'tmp',
  'tmpdir',
  'lang',
  'lc_all',
  'lc_ctype',
  'tz',
])

/** Defesa em profundidade: nunca deixa passar material de credencial. */
const SECRETISH_KEY = /(api[_-]?key|secret|password|passwd|bearer|token)/i

function hasCodexHome(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some((key) => key.toLowerCase() === 'codex_home')
}

/**
 * Constrói o env mínimo para helpers do ai-memory. `CODEX_HOME` só entra com
 * `allowCodexHome` (nunca tokens). PATH/SystemRoot/TEMP e afins sobrevivem.
 */
export function buildAiMemoryHelperEnv(options: AiMemoryProcessEnvOptions = {}): NodeJS.ProcessEnv {
  const base = options.base ?? process.env
  const env: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (!BASE_ENV_ALLOWLIST.has(key.toLowerCase())) continue
    if (SECRETISH_KEY.test(key)) continue
    env[key] = value
  }

  if (options.overlay) {
    for (const [key, value] of Object.entries(options.overlay)) {
      if (value === undefined) continue
      if (key.toLowerCase() === 'codex_home') {
        if (options.allowCodexHome) env[key] = value
        continue
      }
      if (SECRETISH_KEY.test(key)) continue
      env[key] = value
    }
  }

  if (options.allowCodexHome && !hasCodexHome(env) && base.CODEX_HOME) {
    env.CODEX_HOME = base.CODEX_HOME
  }

  return env
}
