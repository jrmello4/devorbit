import { beforeEach, describe, expect, it } from 'vitest'
import {
  armAgentTaskResult,
  claimAgentTaskDelivery,
  clearAgentTaskResult,
  isAgentTaskDelivered,
  peekAgentTaskResult,
  resetAgentTaskDeliveries,
  settleAgentTaskDelivery,
  takeAgentTaskResult,
} from '../src/renderer/src/components/agent-task-delivery'

beforeEach(() => {
  resetAgentTaskDeliveries()
})

describe('agent task delivery registry (exatamente-uma-vez canvas → terminal)', () => {
  it('reserva a primeira entrega e devolve in-flight para uma remontagem', async () => {
    expect(claimAgentTaskDelivery('t1', 'task-1')).toEqual({ kind: 'reserved' })

    const remounted = claimAgentTaskDelivery('t1', 'task-1')
    expect(remounted.kind).toBe('in-flight')
    if (remounted.kind !== 'in-flight') throw new Error('esperava in-flight')

    settleAgentTaskDelivery('t1', 'task-1', true)
    await expect(remounted.completion).resolves.toBe(true)
    expect(isAgentTaskDelivered('t1', 'task-1')).toBe(true)
    expect(claimAgentTaskDelivery('t1', 'task-1')).toEqual({ kind: 'delivered' })
  })

  it('libera retry quando a entrega reservada falha', async () => {
    claimAgentTaskDelivery('t1', 'task-1')
    const waiter = claimAgentTaskDelivery('t1', 'task-1')
    if (waiter.kind !== 'in-flight') throw new Error('esperava in-flight')

    settleAgentTaskDelivery('t1', 'task-1', false)
    await expect(waiter.completion).resolves.toBe(false)
    expect(isAgentTaskDelivered('t1', 'task-1')).toBe(false)
    // O próximo interessado consegue assumir o reenvio.
    expect(claimAgentTaskDelivery('t1', 'task-1')).toEqual({ kind: 'reserved' })
  })

  it('não libera uma entrega já concluída', () => {
    claimAgentTaskDelivery('t1', 'task-1')
    settleAgentTaskDelivery('t1', 'task-1', true)
    settleAgentTaskDelivery('t1', 'task-1', false)
    expect(isAgentTaskDelivered('t1', 'task-1')).toBe(true)
  })

  it('isola terminal e tarefa', () => {
    expect(claimAgentTaskDelivery('t1', 'task-1').kind).toBe('reserved')
    expect(claimAgentTaskDelivery('t2', 'task-1').kind).toBe('reserved')
    expect(claimAgentTaskDelivery('t1', 'task-2').kind).toBe('reserved')
  })
})

describe('correlação do resultado PTY após remount (regressão de orquestração)', () => {
  it('preserva o taskId quando o terminal remonta antes do DEVORBIT_RESULT', () => {
    // Instância A: despacha e arma o slot de resultado da tarefa.
    expect(claimAgentTaskDelivery('agent-1', 'task-1')).toEqual({ kind: 'reserved' })
    armAgentTaskResult('agent-1', 'task-1')

    // A desmonta antes do marcador; B remonta e encontra a entrega in-flight.
    const remount = claimAgentTaskDelivery('agent-1', 'task-1')
    expect(remount.kind).toBe('in-flight')
    armAgentTaskResult('agent-1', 'task-1')

    // O listener de B consome o marcador com o taskId correto (não `undefined`).
    expect(takeAgentTaskResult('agent-1')).toBe('task-1')
    // Consumido exatamente uma vez.
    expect(takeAgentTaskResult('agent-1')).toBeUndefined()
  })

  it('mantém a correlação pendente mesmo com a entrega já confirmada', () => {
    claimAgentTaskDelivery('t1', 'task-1')
    armAgentTaskResult('t1', 'task-1')
    settleAgentTaskDelivery('t1', 'task-1', true)

    // Remontagem após handoff: claim `delivered`, mas o marcador ainda não veio.
    expect(claimAgentTaskDelivery('t1', 'task-1')).toEqual({ kind: 'delivered' })
    armAgentTaskResult('t1', 'task-1')
    expect(takeAgentTaskResult('t1')).toBe('task-1')
  })

  it('não atribui resultado de outro terminal e limpa só a tarefa certa', () => {
    armAgentTaskResult('t1', 'task-1')
    armAgentTaskResult('t2', 'task-2')

    clearAgentTaskResult('t1', 'task-9')
    expect(peekAgentTaskResult('t1')).toBe('task-1')

    clearAgentTaskResult('t1', 'task-1')
    expect(takeAgentTaskResult('t1')).toBeUndefined()
    expect(takeAgentTaskResult('t2')).toBe('task-2')
  })
})
