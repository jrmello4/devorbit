/**
 * Path-scoped async lock for config writes.
 *
 * Serializes concurrent writes to the SAME config file path. Writes to
 * different paths proceed in parallel. Used by syncAiUsagebarAccounts,
 * ensureConfigFile, detect, and setVendorEnabled to prevent lost updates.
 *
 * Separate from usageLock (Codex token rotation), which remains independent.
 *
 * Exports a module-level singleton (`sharedConfigWriteLock`) so that the
 * service and account sync share one lock without index.ts wiring.
 *
 * Path keys are normalized with `path.resolve` so that `C:\X\c.toml` and
 * `c:/./x/c.toml` share the same queue. On Windows the comparison is
 * case-insensitive.
 */

import path from 'node:path'

function normalizeLockKey(configPath: string): string {
  const resolved = path.resolve(configPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export interface ConfigWriteLock {
  /** Run fn while holding the lock for configPath. Queues behind any preceding call to the same path. */
  withConfigLock<T>(configPath: string, fn: () => Promise<T>): Promise<T>
}

export function createConfigWriteLock(): ConfigWriteLock {
  const tails = new Map<string, Promise<unknown>>()

  return {
    withConfigLock<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
      const key = normalizeLockKey(configPath)
      const previous = tails.get(key) ?? Promise.resolve()
      const run = previous.then(() => fn(), () => fn())
      const sentinel = run.then(() => undefined, () => undefined)
      tails.set(key, sentinel)
      void run.then(
        () => { if (tails.get(key) === sentinel) tails.delete(key) },
        () => { if (tails.get(key) === sentinel) tails.delete(key) },
      )
      return run
    },
  }
}

/** Module-level singleton shared by service and account sync. */
export const sharedConfigWriteLock: ConfigWriteLock = createConfigWriteLock()
