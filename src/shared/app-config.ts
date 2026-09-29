/**
 * Contrato de configuração do DevOrbit (fonte única main ↔ renderer).
 *
 * Este módulo NÃO importa Electron nem módulos de UI: só tipos e constantes.
 * Pode ser consumido por main, preload, renderer e testes sem risco de ciclo.
 * O renderer re-exporta tudo daqui via `src/renderer/src/types.ts`.
 */
import type { AgentProviderId } from './agent-provider-contract'
import type { CustomTerminalPreset } from './terminal-presets'
import type { GitStatus } from './git-contract'

export interface TechStack {
  id: string
  label: string
  color: string
}

export interface Project {
  id: string
  name: string
  path: string
  parentDir: string
  lastModified: number
  techs: TechStack[]
  packageManager?: string
  scripts?: string[]
  git: GitStatus
  /** Metadata retained when the local working copy is released. */
  remoteUrl?: string
  parentPath?: string
  lifecycle?: 'local' | 'archived'
}

export interface ManagedProject {
  id: string
  name: string
  parentPath: string
  folderName: string
  remoteUrl: string
  branch: string
  registeredAt: string
}

export interface OtherDir {
  name: string
  path: string
  parentDir: string
}

export interface AutomationConfig {
  /** Executor padrão para nós novos e nós antigos sem provider explícito. */
  defaultExecutor?: AgentProviderId
  /** Conta Codex padrão quando o executor padrão é o Codex. */
  defaultCodexAccount?: 'account1' | 'account2'
  /** Inicia o executor padrão automaticamente ao abrir o terminal primário. */
  autoStartExecutor?: boolean
  /** Reabre o workspace configurado na inicialização do app. */
  restoreWorkspace?: boolean
  /** Projeto restaurado quando restoreWorkspace está ativo. */
  restoreProjectId?: string
}

/**
 * Nomes das chaves BYOK. A lista é a fonte única para config (armazenamento
 * seguro), validação e UI. Os valores NUNCA devem ser enviados ao renderer.
 */
export const MODEL_ROUTING_SECRET_KEYS = [
  'openaiApiKey',
  'anthropicApiKey',
  'geminiApiKey',
  'deepseekApiKey',
  'glmApiKey',
  'kimiApiKey',
  'minimaxApiKey',
  'vllmApiKey',
] as const

export type ModelRoutingSecretKey = (typeof MODEL_ROUTING_SECRET_KEYS)[number]

/** URLs base opcionais por provedor (não são segredos e podem ir ao renderer). */
export const MODEL_ROUTING_BASE_URL_KEYS = [
  'openaiBaseUrl',
  'anthropicBaseUrl',
  'geminiBaseUrl',
  'deepseekBaseUrl',
  'glmBaseUrl',
  'kimiBaseUrl',
  'minimaxBaseUrl',
  'ollamaBaseUrl',
  'vllmBaseUrl',
] as const

export type ModelRoutingBaseUrlKey = (typeof MODEL_ROUTING_BASE_URL_KEYS)[number]

/**
 * Credenciais BYOK. Preenchidas apenas no processo main (decifradas do
 * armazenamento seguro) e nunca devolvidas ao renderer.
 */
export interface ModelRoutingSecrets {
  openaiApiKey?: string
  anthropicApiKey?: string
  geminiApiKey?: string
  deepseekApiKey?: string
  glmApiKey?: string
  kimiApiKey?: string
  minimaxApiKey?: string
  vllmApiKey?: string
}

export interface ModelRoutingConfig extends ModelRoutingSecrets {
  fastModel?: string
  deepModel?: string
  openaiBaseUrl?: string
  anthropicBaseUrl?: string
  geminiBaseUrl?: string
  deepseekBaseUrl?: string
  glmBaseUrl?: string
  kimiBaseUrl?: string
  minimaxBaseUrl?: string
  ollamaBaseUrl?: string
  vllmBaseUrl?: string
  /** Visão segura: indica que há chave configurada sem revelar o valor. */
  hasOpenaiKey?: boolean
  hasAnthropicKey?: boolean
  hasGeminiKey?: boolean
  hasDeepseekKey?: boolean
  hasGlmKey?: boolean
  hasKimiKey?: boolean
  hasMinimaxKey?: boolean
  hasVllmKey?: boolean
}

/** Caminhos de ferramentas externas configurados pelo usuário. */
export interface CustomPaths {
  brave?: string
  chrome?: string
  mimo?: string
  agy?: string
  codex?: string
  opencode?: string
  opencode2?: string
  claude?: string
  gemini?: string
  aider?: string
  commandCode?: string
  customAgent?: string
  vscode?: string
  wt?: string
}

export interface AppConfig {
  projectDirs: string[]
  managedProjects: ManagedProject[]
  projectAccounts: Record<string, 'account1' | 'account2'>
  activeChatGptAccount: 'account1' | 'account2'
  chatGptAccount1Name: string
  chatGptAccount2Name: string
  customPaths: CustomPaths
  modelRouting?: ModelRoutingConfig
  automation?: AutomationConfig
  /** Presets de terminal personalizados criados pelo usuário (Smart Terminals). */
  terminalPresets?: CustomTerminalPreset[]
  /** Ids de provedores do ai-usagebar ocultos na tela "Provedores & Quotas de IA". */
  aiUsagebarHiddenProviders?: string[]
  /**
   * Somente leitura (processo main → renderer): true quando o armazenamento
   * seguro está indisponível e as credenciais BYOK existem apenas na memória
   * desta sessão — nada é gravado em disco. Nunca é persistido nem aceito em
   * atualizações de configuração.
   */
  secretsSessionOnly?: boolean
}
