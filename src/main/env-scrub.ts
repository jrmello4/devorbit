/**
 * Variáveis que nunca podem vazar para processos externos (CLI de login,
 * launchers, Explorer): credenciais temporárias da Agent Bridge e o fuse
 * ELECTRON_RUN_AS_NODE do runtime MCP. Comparação case-insensitive.
 */
export const BRIDGE_SCRUBBED_ENV_NAMES = [
  'DEVORBIT_BRIDGE_PIPE',
  'DEVORBIT_BRIDGE_TOKEN',
  'DEVORBIT_SESSION_ID',
  'DEVORBIT_BRIDGE_ORIGIN',
  'DEVORBIT_BRIDGE_DEPTH',
  'DEVORBIT_BRIDGE_VISITED',
  'ELECTRON_RUN_AS_NODE',
] as const

export function scrubBridgeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(result)) {
    if (BRIDGE_SCRUBBED_ENV_NAMES.some((name) => name.toLowerCase() === key.toLowerCase())) {
      delete result[key]
    }
  }
  return result
}
