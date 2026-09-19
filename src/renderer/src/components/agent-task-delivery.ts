/**
 * Registro idempotente de entrega de tarefas do canvas.
 *
 * Vive no módulo (não na instância React) para sobreviver a remontagens do
 * `WorkspaceTerminal`. Garante entrega exatamente-uma-vez:
 *
 * - quem reserva primeiro entrega; um `WorkspaceTerminal` remontado vê
 *   `in-flight` e aguarda a conclusão em vez de reenviar;
 * - se a entrega reservada falhar, o próximo interessado assume o retry;
 * - quando entrega, o registro fica `delivered` e novas remontagens não
 *   reenviam a mesma tarefa.
 */
export type AgentTaskDeliveryClaim =
  | { kind: 'reserved' }
  | { kind: 'delivered' }
  | { kind: 'in-flight'; completion: Promise<boolean> }

interface DeliveryRecord {
  state: 'in-flight' | 'delivered'
  completion: Promise<boolean>
  resolve: (delivered: boolean) => void
}

const MAX_TRACKED_DELIVERIES = 256
const deliveries = new Map<string, DeliveryRecord>()

function deliveryKey(terminalId: string, taskId: string): string {
  return `${terminalId}::${taskId}`
}

function prune(): void {
  while (deliveries.size > MAX_TRACKED_DELIVERIES) {
    const oldest = deliveries.keys().next()
    if (oldest.done) return
    deliveries.delete(oldest.value)
  }
}

/**
 * Reserva a entrega. `reserved` = esta instância deve entregar; `in-flight` =
 * outra instância está entregando (aguarde a `completion`); `delivered` = já
 * entregue (não reenviar).
 */
export function claimAgentTaskDelivery(terminalId: string, taskId: string): AgentTaskDeliveryClaim {
  const key = deliveryKey(terminalId, taskId)
  const existing = deliveries.get(key)
  if (existing) {
    return existing.state === 'delivered'
      ? { kind: 'delivered' }
      : { kind: 'in-flight', completion: existing.completion }
  }
  let resolve!: (delivered: boolean) => void
  const completion = new Promise<boolean>((settle) => { resolve = settle })
  deliveries.set(key, { state: 'in-flight', completion, resolve })
  prune()
  return { kind: 'reserved' }
}

/**
 * Conclui uma reserva. `true` mantém o registro como `delivered`; `false`
 * libera a tarefa para um retry.
 */
export function settleAgentTaskDelivery(terminalId: string, taskId: string, delivered: boolean): void {
  const key = deliveryKey(terminalId, taskId)
  const record = deliveries.get(key)
  if (!record) return
  // Uma entrega concluída não pode ser "desfeita" por um sinal tardio.
  if (record.state === 'delivered') return
  if (delivered) {
    record.state = 'delivered'
    record.resolve(true)
    return
  }
  deliveries.delete(key)
  record.resolve(false)
  prune()
}

export function isAgentTaskDelivered(terminalId: string, taskId: string): boolean {
  return deliveries.get(deliveryKey(terminalId, taskId))?.state === 'delivered'
}

/**
 * Slot de correlação do PRÓXIMO marcador `DEVORBIT_RESULT` por terminal.
 *
 * Vive no módulo para sobreviver a remontagens: se o `WorkspaceTerminal`
 * remonta entre o dispatch e o marcador, a nova instância ainda encontra a
 * tarefa despachada aqui e o resultado PTY chega com o `taskId` correto em vez
 * de `undefined` (o que travaria a orquestração).
 */
const activeResultTasks = new Map<string, string>()

export function armAgentTaskResult(terminalId: string, taskId: string): void {
  activeResultTasks.set(terminalId, taskId)
}

/** Consome o slot do terminal (um resultado por tarefa despachada). */
export function takeAgentTaskResult(terminalId: string): string | undefined {
  const taskId = activeResultTasks.get(terminalId)
  if (taskId !== undefined) activeResultTasks.delete(terminalId)
  return taskId
}

/** Lê o slot sem consumir (para classificar encerramento/erro). */
export function peekAgentTaskResult(terminalId: string): string | undefined {
  return activeResultTasks.get(terminalId)
}

export function clearAgentTaskResult(terminalId: string, taskId?: string): void {
  if (taskId === undefined || activeResultTasks.get(terminalId) === taskId) {
    activeResultTasks.delete(terminalId)
  }
}

export function resetAgentTaskDeliveries(): void {
  deliveries.clear()
  activeResultTasks.clear()
}
