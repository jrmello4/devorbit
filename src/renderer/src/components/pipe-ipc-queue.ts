/**
 * Fila seriada por origem para `pipeTerminals`: garante a ordem observável
 * clear -> add mesmo sob duas mudanças rápidas de fanout. Uma origem nunca
 * tem duas chamadas IPC em voo ao mesmo tempo; origens distintas são
 * independentes. Erros de uma chamada não travam a fila.
 */
export function createPipeCallQueue(
  send: (from: string, to: string | null) => Promise<unknown>
): (from: string, to: string | null) => Promise<void> {
  const chains = new Map<string, Promise<void>>()
  return (from: string, to: string | null): Promise<void> => {
    const previous = chains.get(from) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => send(from, to))
      .then(
        () => undefined,
        () => undefined
      )
    chains.set(from, next)
    return next
  }
}
