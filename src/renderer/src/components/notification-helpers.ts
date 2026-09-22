/**
 * Helpers para notificações da aplicação.
 * Em conformidade com WCAG 2.2.1 (Timing Adjustable), notificações contendo ações
 * ou reportando erros críticos nunca sofrem auto-dismiss.
 */

export function shouldAutoDismissNotification(
  type: 'success' | 'error' | 'info',
  actions?: ReadonlyArray<{ id: string; label: string }>,
): boolean {
  if (type === 'error') return false
  if (actions && actions.length > 0) return false
  return true
}
