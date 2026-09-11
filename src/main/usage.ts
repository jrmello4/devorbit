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

export type UsageTarget = 'account1' | 'account2' | 'antigravity'
export type AccountTarget = 'account1' | 'account2'

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

const usageMutations: { pending: Promise<void> } = { pending: Promise.resolve() }

function getUsageFilePath(): string {
  const dir = path.join(os.homedir(), '.devorbit')
  return path.join(dir, 'usage.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function cloneAccountUsage(account: AccountUsage): AccountUsage {
  return { ...account }
}

function cloneUsageState(state: UsageTrackerState): UsageTrackerState {
  return {
    account1: cloneAccountUsage(state.account1),
    account2: cloneAccountUsage(state.account2),
    antigravity: { ...state.antigravity },
  }
}

function cloneDefaultState(): UsageTrackerState {
  return cloneUsageState(DEFAULT_STATE)
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeAccountUsage(value: unknown, fallback: AccountUsage): AccountUsage {
  const source = isRecord(value) ? value : {}
  const used = Math.max(0, Math.floor(finiteNumber(source.used, fallback.used)))
  const limit = Math.max(1, Math.floor(finiteNumber(source.limit, fallback.limit)))
  const windowDurationHours = Math.max(
    1,
    finiteNumber(source.windowDurationHours, fallback.windowDurationHours)
  )
  const windowStartValue = finiteNumber(source.windowStart, 0)

  return {
    used,
    limit,
    windowDurationHours,
    ...(windowStartValue > 0 ? { windowStart: windowStartValue } : {}),
  }
}

function normalizeUsageState(value: unknown): UsageTrackerState {
  const source = isRecord(value) ? value : {}
  return {
    account1: normalizeAccountUsage(source.account1, DEFAULT_STATE.account1),
    account2: normalizeAccountUsage(source.account2, DEFAULT_STATE.account2),
    antigravity: {
      sessionCount: Math.max(
        0,
        Math.floor(
          finiteNumber(
            isRecord(source.antigravity) ? source.antigravity.sessionCount : undefined,
            DEFAULT_STATE.antigravity.sessionCount
          )
        )
      ),
    },
  }
}

function isUsageTarget(target: unknown): target is UsageTarget {
  return target === 'account1' || target === 'account2' || target === 'antigravity'
}

function isAccountTarget(target: unknown): target is AccountTarget {
  return target === 'account1' || target === 'account2'
}

function normalizeAccountWindow(account: AccountUsage): AccountUsage {
  const durationMs = account.windowDurationHours * 3600 * 1000
  if (account.windowStart && Date.now() - account.windowStart >= durationMs) {
    return {
      ...account,
      used: 0,
      windowStart: undefined,
    }
  }
  return account
}

function normalizeWindows(state: UsageTrackerState): UsageTrackerState {
  return {
    ...state,
    account1: normalizeAccountWindow(state.account1),
    account2: normalizeAccountWindow(state.account2),
  }
}

async function withUsageMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = usageMutations.pending.then(operation, operation)
  usageMutations.pending = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

async function atomicallyWriteJson(file: string, value: unknown): Promise<void> {
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`
  let renamed = false

  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const handle = await fs.open(temporaryFile, 'w')
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    await fs.rename(temporaryFile, file)
    renamed = true
  } finally {
    if (!renamed) {
      await fs.rm(temporaryFile, { force: true }).catch(() => undefined)
    }
  }
}

export async function getUsageState(): Promise<UsageTrackerState> {
  const file = getUsageFilePath()
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return normalizeWindows(normalizeUsageState(JSON.parse(raw)))
  } catch {
    return cloneDefaultState()
  }
}

export async function saveUsageState(state: UsageTrackerState): Promise<void> {
  const normalized = normalizeWindows(normalizeUsageState(state))
  await atomicallyWriteJson(getUsageFilePath(), normalized)
}

async function updateUsageState(
  update: (state: UsageTrackerState) => void | Promise<void>
): Promise<UsageTrackerState> {
  return withUsageMutation(async () => {
    const state = normalizeWindows(await getUsageState())
    await update(state)
    const normalized = normalizeWindows(normalizeUsageState(state))
    await saveUsageState(normalized)
    return cloneUsageState(normalized)
  })
}

/**
 * Atomically checks the quota and reserves one session. This must be used by
 * launchers instead of reading the state and incrementing it in two steps.
 */
export async function tryReserveUsage(target: UsageTarget): Promise<boolean> {
  if (!isUsageTarget(target)) {
    throw new Error('Destino de uso inválido.')
  }

  return withUsageMutation(async () => {
    const state = normalizeWindows(await getUsageState())

    if (target === 'antigravity') {
      state.antigravity.sessionCount += 1
    } else {
      const account = state[target]
      if (account.used >= account.limit) return false
      if (!account.windowStart || account.used === 0) account.windowStart = Date.now()
      account.used += 1
    }

    await saveUsageState(state)
    return true
  })
}

/** Release a reservation when the process could not be started. */
export async function releaseUsageReservation(target: UsageTarget): Promise<void> {
  if (!isUsageTarget(target)) {
    throw new Error('Destino de uso inválido.')
  }

  await updateUsageState((state) => {
    if (target === 'antigravity') {
      state.antigravity.sessionCount = Math.max(0, state.antigravity.sessionCount - 1)
      return
    }

    const account = state[target]
    account.used = Math.max(0, account.used - 1)
    if (account.used === 0) account.windowStart = undefined
  })
}

export async function incrementUsage(target: UsageTarget): Promise<UsageTrackerState> {
  if (!isUsageTarget(target)) {
    throw new Error('Destino de uso inválido.')
  }

  return updateUsageState((state) => {
    if (target === 'antigravity') {
      state.antigravity.sessionCount += 1
      return
    }

    const account = state[target]
    if (!account.windowStart || account.used === 0) account.windowStart = Date.now()
    account.used += 1
  })
}

export async function decrementUsage(target: AccountTarget): Promise<UsageTrackerState> {
  if (!isAccountTarget(target)) {
    throw new Error('Conta de uso inválida.')
  }

  return updateUsageState((state) => {
    const account = state[target]
    account.used = Math.max(0, account.used - 1)
    if (account.used === 0) account.windowStart = undefined
  })
}

export async function resetUsageWindow(target: AccountTarget): Promise<UsageTrackerState> {
  if (!isAccountTarget(target)) {
    throw new Error('Conta de uso inválida.')
  }

  return updateUsageState((state) => {
    state[target].used = 0
    state[target].windowStart = undefined
  })
}

export async function updateUsageLimits(
  account: AccountTarget,
  limit: number,
  windowHours: number = 3
): Promise<UsageTrackerState> {
  if (!isAccountTarget(account)) {
    throw new Error('Conta de uso inválida.')
  }

  return updateUsageState((state) => {
    const current = state[account]
    const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : current.limit
    const normalizedWindow = Number.isFinite(windowHours)
      ? windowHours
      : current.windowDurationHours
    current.limit = Math.max(1, normalizedLimit)
    current.windowDurationHours = Math.max(1, normalizedWindow)
  })
}
