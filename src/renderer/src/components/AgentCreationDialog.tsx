import React, { useEffect, useMemo, useState } from 'react'
import { Check, X, Plus, Trash2, Crown, Sparkles, Users, Bot } from 'lucide-react'
import type { AgentProvider, AgentProviderId, CodexAccountStatus } from '../types'
import {
  canSubmitAgentCreation,
  canSubmitSquadCreation,
  BUILT_IN_AGENT_ROLES,
  type AgentAccountId,
  type AgentCreationSpec,
  type SquadCreationSpec,
} from './agent-creation-helpers'
import { AccessibleDialog } from './AccessibleDialog'

export interface AgentCreationDialogProps {
  isOpen: boolean
  mode: 'agent' | 'squad'
  providers: AgentProvider[]
  defaultProvider?: AgentProviderId | null
  codexAuthStatus?: CodexAccountStatus | null
  onClose: () => void
  onRequestCodexAuth?: (account: AgentAccountId) => void
  onCreateAgent: (spec: AgentCreationSpec) => void
  onCreateSquad: (spec: SquadCreationSpec) => void
}

interface ParticipantEntry {
  id: string
  role: string
  provider: AgentProviderId | null
  account: AgentAccountId | null
}

function createParticipant(
  role: string,
  defaultProvider?: AgentProviderId | null,
): ParticipantEntry {
  return {
    id: 'part-' + Math.random().toString(36).slice(2, 9),
    role,
    provider: defaultProvider ?? null,
    account: null,
  }
}

export const AgentCreationDialog: React.FC<AgentCreationDialogProps> = ({
  isOpen,
  mode,
  providers,
  defaultProvider = null,
  codexAuthStatus = null,
  onClose,
  onRequestCodexAuth,
  onCreateAgent,
  onCreateSquad,
}) => {
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')

  // Modo agente individual
  const [agentRole, setAgentRole] = useState('Implementação')
  const [agentProvider, setAgentProvider] = useState<AgentProviderId | null>(defaultProvider ?? null)
  const [agentAccount, setAgentAccount] = useState<AgentAccountId | null>(null)

  // Modo squad: lista dinâmica de participantes e índice explícito de coordenação (null = sem coordenador)
  const [participants, setParticipants] = useState<ParticipantEntry[]>([
    createParticipant('Coordenador', defaultProvider),
    createParticipant('Implementação', defaultProvider),
  ])
  const [coordinatorIndex, setCoordinatorIndex] = useState<number | null>(0)

  useEffect(() => {
    if (!isOpen) return
    setTitle(mode === 'squad' ? 'Squad Ágil' : 'Novo agente')
    setObjective('')
    setAgentRole('Implementação')
    setAgentProvider(defaultProvider ?? null)
    setAgentAccount(null)
    setParticipants([
      createParticipant('Coordenador', defaultProvider),
      createParticipant('Implementação', defaultProvider),
    ])
    setCoordinatorIndex(0)
  }, [isOpen, mode, defaultProvider])

  const readyProviders = useMemo(
    () => providers.filter((provider) => provider.state === 'ready'),
    [providers],
  )

  // Templates de Squad
  const applySquadTemplate = (template: 'trio' | 'pair' | 'full') => {
    if (template === 'pair') {
      setParticipants([
        createParticipant('Coordenador', defaultProvider),
        createParticipant('Implementação', defaultProvider),
      ])
      setCoordinatorIndex(0)
    } else if (template === 'trio') {
      setParticipants([
        createParticipant('Coordenador', defaultProvider),
        createParticipant('Implementação', defaultProvider),
        createParticipant('Testes', defaultProvider),
      ])
      setCoordinatorIndex(0)
    } else if (template === 'full') {
      setParticipants([
        createParticipant('Coordenador', defaultProvider),
        createParticipant('Implementação', defaultProvider),
        createParticipant('Revisão', defaultProvider),
        createParticipant('Testes', defaultProvider),
      ])
      setCoordinatorIndex(0)
    }
  }

  // Manipulação de participantes da squad
  const addParticipant = (role = 'Implementação') => {
    setParticipants((curr) => [...curr, createParticipant(role, defaultProvider)])
  }

  const removeParticipant = (indexToRemove: number) => {
    setParticipants((curr) => {
      if (curr.length <= 1) return curr
      return curr.filter((_, idx) => idx !== indexToRemove)
    })
    setCoordinatorIndex((currCoord) => {
      if (currCoord === null) return null
      if (currCoord === indexToRemove) return null // coordenador foi removido -> sem coordenador
      if (currCoord > indexToRemove) return currCoord - 1
      return currCoord
    })
  }

  const updateParticipant = (index: number, update: Partial<ParticipantEntry>) => {
    setParticipants((curr) =>
      curr.map((p, idx) => {
        if (idx !== index) return p
        const next = { ...p, ...update }
        if (next.provider !== 'codex') next.account = null
        return next
      }),
    )
  }

  const renderProviderSelect = (
    providerValue: AgentProviderId | null,
    onChange: (provider: AgentProviderId | null) => void,
    ariaLabel: string,
  ) => (
    <select
      aria-label={ariaLabel}
      value={providerValue || ''}
      onChange={(e) => onChange((e.target.value || null) as AgentProviderId | null)}
      className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
    >
      <option value="">Escolha o provedor...</option>
      {providers.map((p) => (
        <option key={p.id} value={p.id} disabled={p.state !== 'ready'}>
          {p.label} {p.state !== 'ready' ? '(indisponível)' : ''}
        </option>
      ))}
    </select>
  )

  const renderCodexAccountSelect = (
    accountValue: AgentAccountId | null,
    onChange: (acc: AgentAccountId | null) => void,
    roleLabel: string,
  ) => (
    <div className="space-y-1.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] p-2">
      <span className="block text-[11px] font-semibold text-[var(--color-text-secondary)]">
        Conta Codex ({roleLabel})
      </span>
      <div className="grid grid-cols-2 gap-2">
        {(['account1', 'account2'] as AgentAccountId[]).map((account) => {
          const connected = codexAuthStatus?.[account]?.connected
          return (
            <label
              key={account}
              className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-text-secondary)]"
            >
              <input
                type="radio"
                name={`codex-acc-${roleLabel}-${account}`}
                checked={accountValue === account}
                onChange={() => onChange(account)}
              />
              <span>
                {account === 'account1' ? 'Conta 1' : 'Conta 2'}
                {connected ? ' · pronta' : ' · desconectada'}
              </span>
            </label>
          )
        })}
      </div>
      {accountValue && !codexAuthStatus?.[accountValue]?.connected && onRequestCodexAuth && (
        <button
          type="button"
          className="text-[11px] font-semibold text-[var(--color-accent-strong)] underline"
          onClick={() => onRequestCodexAuth(accountValue)}
        >
          Conectar conta agora
        </button>
      )}
    </div>
  )

  if (!isOpen) return null

  const agentSpec: AgentCreationSpec = {
    role: agentRole.trim() || 'Implementação',
    provider: agentProvider,
    account: agentAccount,
    title: title.trim() || undefined,
  }
  const validAgent = canSubmitAgentCreation(agentSpec, readyProviders)

  const squadSpec: SquadCreationSpec = {
    title: title.trim(),
    objective: objective.trim() || undefined,
    participants: participants.map((p) => ({
      role: p.role.trim() || 'Implementação',
      provider: p.provider,
      account: p.account,
    })),
    coordinatorIndex,
  }
  const validSquad = canSubmitSquadCreation(squadSpec, readyProviders)

  const handleSubmit = () => {
    if (mode === 'agent') {
      if (validAgent) onCreateAgent(agentSpec)
    } else if (validSquad) {
      onCreateSquad(squadSpec)
    }
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="agent-creation-dialog-title"
      onClose={onClose}
      className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] shadow-xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--surface-muted)] px-5 py-4">
        <div className="flex items-center gap-2">
          {mode === 'squad' ? <Users size={18} aria-hidden="true" /> : <Bot size={18} aria-hidden="true" />}
          <div>
            <h2 id="agent-creation-dialog-title" className="text-base font-bold text-[var(--text-primary)]">
              {mode === 'agent' ? 'Configurar Agente' : 'Configurar Squad de Agentes'}
            </h2>
            <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
              {mode === 'agent'
                ? 'Defina o papel (preset ou customizado) e o provedor do agente.'
                : 'Adicione membros, papéis customizados e escolha o coordenador explicitamente.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cancelar criação"
          className="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {/* Body */}
      <div className="max-h-[calc(100dvh-220px)] space-y-4 overflow-y-auto p-5">
        {/* Título / Nome */}
        <label className="block text-xs font-semibold text-[var(--color-text-secondary)]">
          {mode === 'squad' ? 'Nome da Squad' : 'Título do Agente'}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder={mode === 'squad' ? 'ex.: Squad Ágil' : 'ex.: Agente de Backend'}
            className="mt-1.5 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--text-primary)]"
            autoFocus
          />
        </label>

        {/* Objetivo da Squad (opcional) */}
        {mode === 'squad' && (
          <label className="block text-xs font-semibold text-[var(--color-text-secondary)]">
            Objetivo da Squad (opcional)
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="Descreva a meta principal ou contexto da squad..."
              className="mt-1.5 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-[var(--text-primary)]"
            />
          </label>
        )}

        {/* Modo Agente Individual */}
        {mode === 'agent' && (
          <div className="space-y-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] p-3">
            <div>
              <label className="block text-xs font-semibold text-[var(--color-text-secondary)]">
                Papel do Agente (preset ou customizado)
              </label>
              <input
                list="agent-builtin-roles"
                value={agentRole}
                onChange={(e) => setAgentRole(e.target.value)}
                maxLength={40}
                placeholder="ex.: Backend, Frontend, QA, Coordenador..."
                className="mt-1.5 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]"
              />
              <datalist id="agent-builtin-roles">
                {BUILT_IN_AGENT_ROLES.map((role) => (
                  <option key={role} value={role} />
                ))}
              </datalist>
            </div>

            {renderProviderSelect(
              agentProvider,
              (p) => {
                setAgentProvider(p)
                if (p !== 'codex') setAgentAccount(null)
              },
              'Provedor do agente',
            )}

            {agentProvider === 'codex' &&
              renderCodexAccountSelect(agentAccount, setAgentAccount, agentRole || 'Agente')}
          </div>
        )}

        {/* Modo Squad: Templates e Lista Dinâmica de Participantes */}
        {mode === 'squad' && (
          <div className="space-y-4">
            {/* Templates Rápidos */}
            <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] p-3">
              <span className="block text-xs font-semibold text-[var(--color-text-secondary)]">
                Templates Rápidos de Squad
              </span>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => applySquadTemplate('trio')}
                  className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--color-accent-strong)]"
                >
                  <Sparkles size={11} className="mr-1 inline text-amber-400" />
                  Trio Ágil (Coord + Dev + Testes)
                </button>
                <button
                  type="button"
                  onClick={() => applySquadTemplate('pair')}
                  className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--color-accent-strong)]"
                >
                  Pair (Coord + Dev)
                </button>
                <button
                  type="button"
                  onClick={() => applySquadTemplate('full')}
                  className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--color-accent-strong)]"
                >
                  Full Squad (Coord + Dev + Rev + Testes)
                </button>
              </div>
            </div>

            {/* Escolha Explícita de Coordenador */}
            <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] p-3">
              <span className="block text-xs font-semibold text-[var(--color-text-secondary)]">
                Coordenação da Squad
              </span>
              <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                O coordenador é independente do papel textual e dispara a orquestração do squad.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2.5 py-1.5 text-xs text-[var(--text-primary)]">
                  <input
                    type="radio"
                    name="squad-coordinator-selection"
                    checked={coordinatorIndex === null}
                    onChange={() => setCoordinatorIndex(null)}
                  />
                  <span>Sem coordenador (avulso)</span>
                </label>

                {participants.map((p, idx) => (
                  <label
                    key={p.id}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${
                      coordinatorIndex === idx
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-300 font-semibold'
                        : 'border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] text-[var(--text-primary)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="squad-coordinator-selection"
                      checked={coordinatorIndex === idx}
                      onChange={() => setCoordinatorIndex(idx)}
                    />
                    <span>
                      {coordinatorIndex === idx && <Crown size={11} className="mr-1 inline text-amber-400" />}
                      Membro #{idx + 1} ({p.role || 'Especialista'})
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Lista Dinâmica de Participantes */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                  Participantes da Squad ({participants.length})
                </span>
                <button
                  type="button"
                  onClick={() => addParticipant('Implementação')}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--surface-muted)] px-2.5 py-1 text-xs font-semibold text-[var(--color-accent-strong)] hover:bg-[var(--surface-hover)]"
                >
                  <Plus size={12} aria-hidden="true" /> Adicionar Participante
                </button>
              </div>

              {participants.map((participant, index) => {
                const isCoordinator = coordinatorIndex === index

                return (
                  <div
                    key={participant.id}
                    className={`space-y-2.5 rounded-lg border p-3 ${
                      isCoordinator
                        ? 'border-amber-500/40 bg-[var(--surface-muted)]'
                        : 'border-[var(--color-border-subtle)] bg-[var(--surface-muted)]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {isCoordinator && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-400"
                            title="Designado como coordenador da squad"
                          >
                            <Crown size={11} aria-hidden="true" /> COORDENADOR
                          </span>
                        )}
                        <span className="text-xs font-semibold text-[var(--text-primary)]">
                          Membro #{index + 1}
                        </span>
                      </div>

                      {participants.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeParticipant(index)}
                          className="rounded p-1 text-[var(--color-text-muted)] hover:text-red-400"
                          aria-label={`Remover participante ${index + 1}`}
                          title="Remover participante"
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      )}
                    </div>

                    {/* Papel Customizável & Provedor */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] font-medium text-[var(--color-text-secondary)]">
                          Papel (preset ou custom)
                        </label>
                        <input
                          list={`roles-list-${participant.id}`}
                          value={participant.role}
                          onChange={(e) => updateParticipant(index, { role: e.target.value })}
                          placeholder="ex.: Backend, UX, Testes..."
                          maxLength={40}
                          className="mt-1 w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-panel)] px-2 py-1 text-xs text-[var(--text-primary)]"
                        />
                        <datalist id={`roles-list-${participant.id}`}>
                          {BUILT_IN_AGENT_ROLES.map((r) => (
                            <option key={r} value={r} />
                          ))}
                        </datalist>
                      </div>

                      <div>
                        <label className="block text-[11px] font-medium text-[var(--color-text-secondary)]">
                          Provedor
                        </label>
                        <div className="mt-1">
                          {renderProviderSelect(
                            participant.provider,
                            (provider) => updateParticipant(index, { provider }),
                            `Provedor do membro ${index + 1}`,
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Conta Codex */}
                    {participant.provider === 'codex' &&
                      renderCodexAccountSelect(
                        participant.account,
                        (account) => updateParticipant(index, { account }),
                        `Membro ${index + 1} (${participant.role})`,
                      )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <p className="text-[11px] text-[var(--color-text-muted)]">
          Provedores indisponíveis permanecem desabilitados. Cada agente precisa de um provedor válido configurado.
        </p>
      </div>

      {/* Footer */}
      <div className="flex justify-end gap-2 border-t border-[var(--color-border-subtle)] bg-[var(--surface-muted)] px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-[var(--color-border-subtle)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-panel)]"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={mode === 'agent' ? !validAgent : !validSquad}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent-strong)] px-3 py-2 text-xs font-semibold text-[var(--color-accent-contrast)] hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Check size={14} aria-hidden="true" />
          {mode === 'agent' ? 'Criar Agente' : 'Criar Squad'}
        </button>
      </div>
    </AccessibleDialog>
  )
}
