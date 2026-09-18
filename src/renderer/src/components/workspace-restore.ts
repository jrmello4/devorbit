import type { AutomationConfig } from '../types'

/**
 * Decide se o workspace configurado deve ser restaurado agora. `alreadyRestored`
 * garante uma única restauração por sessão — refresh manual/automático e
 * re-renders nunca reabrem o ambiente.
 */
export function resolveRestorableProjectId(
  automation: AutomationConfig | null | undefined,
  projectIds: readonly string[],
  alreadyRestored: boolean,
): string | undefined {
  if (alreadyRestored) return undefined
  const projectId = automation?.restoreProjectId
  if (!automation?.restoreWorkspace || !projectId) return undefined
  return projectIds.includes(projectId) ? projectId : undefined
}
