export interface Disposable {
  dispose(): void
}

export interface AsyncDisposable {
  disposeAsync(): Promise<void>
}

export type DisposableLike = Disposable | AsyncDisposable

export function isDisposable(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Disposable).dispose === 'function'
  )
}

export function isAsyncDisposable(value: unknown): value is AsyncDisposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncDisposable).disposeAsync === 'function'
  )
}

export function toDisposable(dispose: () => void): Disposable {
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      dispose()
    },
  }
}

async function disposeItem(item: DisposableLike): Promise<void> {
  if (isAsyncDisposable(item)) {
    await item.disposeAsync()
    return
  }
  if (isDisposable(item)) item.dispose()
}

export class DisposableStore implements Disposable, AsyncDisposable {
  private readonly items = new Set<DisposableLike>()
  private isDisposed = false

  get disposed(): boolean {
    return this.isDisposed
  }

  add<T extends DisposableLike>(item: T): T {
    if (this.isDisposed) {
      void disposeItem(item)
      return item
    }
    this.items.add(item)
    return item
  }

  delete(item: DisposableLike): boolean {
    return this.items.delete(item)
  }

  clear(): void {
    for (const item of Array.from(this.items)) {
      this.items.delete(item)
      void disposeItem(item)
    }
  }

  async clearAsync(): Promise<void> {
    for (const item of Array.from(this.items)) {
      this.items.delete(item)
      await disposeItem(item)
    }
  }

  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    this.clear()
  }

  async disposeAsync(): Promise<void> {
    if (this.isDisposed) return
    this.isDisposed = true
    await this.clearAsync()
  }
}
