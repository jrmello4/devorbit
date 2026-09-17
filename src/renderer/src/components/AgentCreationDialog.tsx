import React, { useEffect, useMemo, useState } from 'react'
import { Check, X } from 'lucide-react'
import type { AgentProvider, AgentProviderId, CodexAccountStatus } from '../types'
import {
  canSubmitAgentCreation,
  canSubmitSquadCreation,
  type AgentAccountId,
  type AgentCreationRole,
  type AgentCreationSpec,
  type SquadCreationSpec,
} from './agent-creation-helpers'
import { AccessibleDialog } from './AccessibleDialog'

interface AgentCreationDialogProps {
  isOpen: boolean
  mode: 'agent' | 'squad'
  providers: AgentProvider[]
  codexAuthStatus?: CodexAccountStatus | null
  onClose: () => void
  onRequestCodexAuth?: (account: AgentAccountId) => void
  onCreateAgent: (spec: AgentCreationSpec) => void
  onCreateSquad: (spec: SquadCreationSpec) => void
}

const roles: AgentCreationRole[] = ['Coordenador', 'Implementação', 'Revisão', 'Testes']

function emptySpec(role: AgentCreationRole): AgentCreationSpec {
  return { role, provider: null, account: null }
}

export const AgentCreationDialog: React.FC<AgentCreationDialogProps> = ({
  isOpen,
  mode,
  providers,
  codexAuthStatus = null,
  onClose,
  onRequestCodexAuth,
  onCreateAgent,
  onCreateSquad,
}) => {
  const [title, setTitle] = useState('')
  const [agentSpec, setAgentSpec] = useState<AgentCreationSpec>(() => emptySpec('Implementação'))
  const [selectedRoles, setSelectedRoles] = useState<AgentCreationRole[]>(['Coordenador'])
  const [squadSpecs, setSquadSpecs] = useState<AgentCreationSpec[]>([emptySpec('Coordenador')])

  useEffect(() => {
    if (!isOpen) return
    setTitle(mode === 'squad' ? 'Novo squad' : 'Novo agente')
    setAgentSpec(emptySpec('Implementação'))
    setSelectedRoles(['Coordenador'])
    setSquadSpecs([emptySpec('Coordenador')])
  }, [isOpen, mode])

  const readyProviders = useMemo(
    () => providers.filter((provider) => provider.state === 'ready'),
    [providers],
  )

  const updateSpec = (
    current: AgentCreationSpec,
    update: Partial<AgentCreationSpec>,
  ): AgentCreationSpec => {
    const next = { ...current, ...update }
    if (next.provider !== 'codex') next.account = null
    return next
  }

  const setSquadRoleEnabled = (role: AgentCreationRole, enabled: boolean) => {
    if (role === 'Coordenador') return
    setSelectedRoles((current) => enabled ? [...current, role] : current.filter((item) => item !== role))
    setSquadSpecs((current) => {
      if (!enabled) return current.filter((item) => item.role !== role)
      if (current.some((item) => item.role === role)) return current
      return [...current, emptySpec(role)]
    })
  }

  const setSquadSpec = (role: AgentCreationRole, update: Partial<AgentCreationSpec>) => {
    setSquadSpecs((current) => current.map((item) => item.role === role ? updateSpec(item, update) : item))
  }

  const renderProvider = (
    spec: AgentCreationSpec,
    onChange: (provider: AgentProviderId | null) => void,
  ) => (
    <select
      aria-label={`Provider do agente ${spec.role}`}
      value={spec.provider || ''}
      onChange={(event) => onChange((event.target.value || null) as AgentProviderId | null)}
      className="w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-xs text-stone-800"
    >
      <option value="">Escolha um provider</option>
      {providers.map((provider) => (
        <option key={provider.id} value={provider.id} disabled={provider.state !== 'ready'}>
          {provider.label}{provider.state !== 'ready' ? ' (indisponível)' : ''}
        </option>
      ))}
    </select>
  )

  const renderAccount = (
    spec: AgentCreationSpec,
    onChange: (account: AgentAccountId | null) => void,
  ) => spec.provider === 'codex' ? (
    <div className="space-y-1.5 rounded-md border border-stone-200 bg-stone-50 p-2">
      <span className="block text-[11px] font-semibold text-stone-700">Conta Codex</span>
      <div className="grid grid-cols-2 gap-2">
        {(['account1', 'account2'] as AgentAccountId[]).map((account) => {
          const connected = codexAuthStatus?.[account]?.connected
          return (
            <label key={account} className="flex cursor-pointer items-center gap-1.5 text-xs text-stone-700">
              <input
                type="radio"
                name={`codex-account-${spec.role}`}
                checked={spec.account === account}
                onChange={() => onChange(account)}
              />
              <span>{account === 'account1' ? 'Conta 1' : 'Conta 2'}{connected ? ' · pronta' : ' · conectar'}</span>
            </label>
          )
        })}
      </div>
      {spec.account && !codexAuthStatus?.[spec.account]?.connected && onRequestCodexAuth && (
        <button
          type="button"
          className="text-[11px] font-semibold text-[#3e562f] underline"
          onClick={() => onRequestCodexAuth(spec.account as AgentAccountId)}
        >
          Conectar conta selecionada
        </button>
      )}
    </div>
  ) : null

  if (!isOpen) return null

  const validAgent = canSubmitAgentCreation(agentSpec, readyProviders)
  const squadSpec: SquadCreationSpec = { title, participants: squadSpecs }
  const validSquad = canSubmitSquadCreation(squadSpec, readyProviders)
  const submit = () => {
    if (mode === 'agent') {
      if (validAgent) onCreateAgent({ ...agentSpec, role: agentSpec.role })
    } else if (validSquad) {
      onCreateSquad({ title: title.trim(), participants: squadSpecs })
    }
  }

  return (
    <AccessibleDialog
      isOpen={isOpen}
      titleId="agent-creation-dialog-title"
      onClose={onClose}
      className="w-full max-w-xl overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-stone-200 bg-stone-50 px-5 py-4">
        <div>
          <h2 id="agent-creation-dialog-title" className="text-base font-bold text-stone-900">
            {mode === 'agent' ? 'Configurar agente' : 'Configurar squad'}
          </h2>
          <p className="mt-0.5 text-xs text-stone-600">Escolha explicitamente quem participa antes de criar.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Cancelar criação" className="rounded-md p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900">
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="max-h-[calc(100dvh-220px)] space-y-4 overflow-y-auto p-5">
        <label className="block text-xs font-semibold text-stone-700">
          Nome
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} className="mt-1.5 w-full rounded-md border border-stone-300 px-3 py-2 text-sm text-stone-900" />
        </label>

        {mode === 'agent' ? (
          <div className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
            <label className="block text-xs font-semibold text-stone-700">
              Papel
              <select value={agentSpec.role} onChange={(event) => setAgentSpec((current) => ({ ...current, role: event.target.value as AgentCreationRole }))} className="mt-1.5 w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-xs text-stone-800">
                {roles.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </label>
            {renderProvider(agentSpec, (provider) => setAgentSpec((current) => updateSpec(current, { provider })))}
            {renderAccount(agentSpec, (account) => setAgentSpec((current) => updateSpec(current, { account })))}
          </div>
        ) : (
          <div className="space-y-3">
            {roles.map((role) => {
              const enabled = selectedRoles.includes(role)
              const spec = squadSpecs.find((item) => item.role === role) || emptySpec(role)
              return (
                <div key={role} className="space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <label className="flex items-center gap-2 text-xs font-semibold text-stone-800">
                    <input type="checkbox" checked={enabled} disabled={role === 'Coordenador'} onChange={(event) => setSquadRoleEnabled(role, event.target.checked)} />
                    {role}{role === 'Coordenador' ? ' (obrigatório)' : ''}
                  </label>
                  {enabled && (
                    <>
                      {renderProvider(spec, (provider) => setSquadSpec(role, { provider }))}
                      {renderAccount(spec, (account) => setSquadSpec(role, { account }))}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <p className="text-[11px] text-stone-500">
          Providers ausentes ou não prontos ficam desabilitados. A seleção não será preenchida automaticamente.
        </p>
      </div>

      <div className="flex justify-end gap-2 border-t border-stone-200 bg-stone-50 px-5 py-3">
        <button type="button" onClick={onClose} className="rounded-md border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700 hover:bg-white">Cancelar</button>
        <button type="button" onClick={submit} disabled={mode === 'agent' ? !validAgent : !validSquad} className="inline-flex items-center gap-1.5 rounded-md bg-[#3e562f] px-3 py-2 text-xs font-semibold text-white hover:bg-[#334827] disabled:cursor-not-allowed disabled:opacity-45">
          <Check size={14} aria-hidden="true" /> Criar
        </button>
      </div>
    </AccessibleDialog>
  )
}

