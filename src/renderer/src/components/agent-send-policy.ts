export type AgentSendProgressState = 'queued' | 'running' | 'completed' | 'blocked'

export interface AgentSendPolicyInput {
  configured: boolean
  configuredMessage: string
  orchestrationActive: boolean
  noteCount: number
  progressState?: AgentSendProgressState | null
}

export type AgentSendBlocker = 'configured' | 'orchestration' | 'progress' | 'note'

export interface AgentSendPolicy {
  disabled: boolean
  reason: string
  /** Bloqueio que impediu o envio (ausente quando habilitado). */
  blocker?: AgentSendBlocker
}

export function agentSendPolicy(input: AgentSendPolicyInput): AgentSendPolicy {
  if (!input.configured) {
    return { disabled: true, reason: input.configuredMessage || 'Configure provider e conta deste agente para ativá-lo.', blocker: 'configured' }
  }
  if (input.orchestrationActive) {
    return { disabled: true, reason: 'Aguarde a orquestração em andamento antes de enviar outra tarefa.', blocker: 'orchestration' }
  }
  if (input.progressState === 'queued' || input.progressState === 'running') {
    return { disabled: true, reason: 'Tarefa em andamento; aguarde o resultado antes de enviar novamente.', blocker: 'progress' }
  }
  if (input.noteCount === 0) {
    return { disabled: true, reason: 'Conecte uma nota com conteúdo a este agente para enviar a tarefa.', blocker: 'note' }
  }
  return { disabled: false, reason: '' }
}
