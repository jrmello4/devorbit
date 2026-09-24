export interface ResolvedTerminalScriptLaunch {
  command: string
  args: string[]
}

/**
 * Resolve o lançamento de um comando do Smart Terminal. Scripts .cmd/.bat não
 * rodam direto no node-pty: passam pelo cmd.exe, como o startCodexTerminal.
 *
 * A rejeição de metacaracteres do cmd.exe aqui é defesa em profundidade, não
 * sandbox: a fronteira de confiança é o renderer validado no IPC (que já
 * poderia pedir `cmd.exe /c ...` diretamente). A checagem existe para que o
 * wrap do `call` não transforme aspas e `& | < > ^` em concatenação de comando.
 */
export function resolveWindowsScriptLaunch(command: string, args: readonly string[] = []): ResolvedTerminalScriptLaunch {
  if (!/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args: [...args] }
  }
  // Dentro do cmd.exe, aspas fecham a string do `call` e & | < > ^ separam
  // comandos; nada disso pode entrar no caminho embrulhado.
  if (command.includes('"')) {
    throw new Error('O comando do terminal contém aspas que o cmd.exe não pode executar com segurança.')
  }
  if (args.some((arg) => /[&|<>^"]/.test(arg))) {
    throw new Error('Os argumentos do terminal contêm metacaracteres que o cmd.exe não pode executar com segurança.')
  }
  return {
    command: process.env.ComSpec || 'cmd.exe',
    // `call` e o caminho como args SEPARADOS: o node-pty escapa aspas internas
    // de um arg único como \" (literal para o cmd — shim "não reconhecido");
    // separados, ele cita o caminho corretamente.
    args: ['/d', '/q', '/k', 'call', command, ...args],
  }
}
