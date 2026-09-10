import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'

export interface AccountUsage {
  used: number
  limit: number
  windowStart?: number // timestamp em ms de quando a janela de 3h iniciou
  windowDurationHours: number // padrão 3h para o ChatGPT Plus
}

export interface UsageTrackerState {
  account1: AccountUsage
  account2: AccountUsage
  antigravity: {
    sessionCount: number
  }
}

const DEFAULT_STATE: UsageTrackerState = {
  account1: {
    used: 0,
    limit: 40,
    windowDurationHours: 3,
  },
  account2: {
    used: 0,
    limit: 40,
    windowDurationHours: 3,
  },
  antigravity: {
    sessionCount: 0,
  },
}

function getUsageFilePath(): string {
  const dir = path.join(os.homedir(), '.devorbit')
  return path.join(dir, 'usage.json')
}

// Verifica e aplica reset caso a janela de tempo tenha expirado
function normalizeAccountUsage(acc: AccountUsage): AccountUsage {
  const durationMs = (acc.windowDurationHours || 3) * 3600 * 1000
  if (acc.windowStart) {
    const elapsed = Date.now() - acc.windowStart
    if (elapsed >= durationMs) {
      // Janela expirou! Reset automático
      return {
        ...acc,
        used: 0,
        windowStart: undefined,
      }
    }
  }
  return acc
}

export async function getUsageState(): Promise<UsageTrackerState> {
  const file = getUsageFilePath()
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed: UsageTrackerState = JSON.parse(raw)
    const normalized: UsageTrackerState = {
      account1: normalizeAccountUsage(parsed.account1 || DEFAULT_STATE.account1),
      account2: normalizeAccountUsage(parsed.account2 || DEFAULT_STATE.account2),
      antigravity: parsed.antigravity || DEFAULT_STATE.antigravity,
    }
    return normalized
  } catch {
    return DEFAULT_STATE
  }
}

export async function saveUsageState(state: UsageTrackerState): Promise<void> {
  const file = getUsageFilePath()
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.error('Falha ao salvar estado de uso do DevOrbit:', err)
  }
}

export async function incrementUsage(
  target: 'account1' | 'account2' | 'antigravity'
): Promise<UsageTrackerState> {
  const state = await getUsageState()

  if (target === 'antigravity') {
    state.antigravity.sessionCount = (state.antigravity.sessionCount || 0) + 1
  } else {
    const acc = state[target]
    const normalized = normalizeAccountUsage(acc)

    // Se o contador estava zerado ou sem janela, inicia nova janela de 3h agora
    if (!normalized.windowStart || normalized.used === 0) {
      normalized.windowStart = Date.now()
    }

    normalized.used = normalized.used + 1
    state[target] = normalized
  }

  await saveUsageState(state)
  return state
}

export async function decrementUsage(
  target: 'account1' | 'account2'
): Promise<UsageTrackerState> {
  const state = await getUsageState()
  const acc = normalizeAccountUsage(state[target])

  acc.used = Math.max(0, acc.used - 1)
  if (acc.used === 0) {
    acc.windowStart = undefined
  }

  state[target] = acc
  await saveUsageState(state)
  return state
}

export async function resetUsageWindow(
  target: 'account1' | 'account2'
): Promise<UsageTrackerState> {
  const state = await getUsageState()
  state[target] = {
    ...state[target],
    used: 0,
    windowStart: undefined,
  }
  await saveUsageState(state)
  return state
}

export async function updateUsageLimits(
  account: 'account1' | 'account2',
  limit: number,
  windowHours: number = 3
): Promise<UsageTrackerState> {
  const state = await getUsageState()
  state[account].limit = Math.max(1, limit)
  state[account].windowDurationHours = Math.max(1, windowHours)
  await saveUsageState(state)
  return state
}
