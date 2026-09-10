import path from 'node:path'
import fs from 'node:fs/promises'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { getGitStatus, getGitChangesSummary } from './git'

const execAsync = promisify(exec)

export interface ProjectMemory {
  content: string
  lastUpdated?: string
  exists: boolean
  path: string
}

const DEFAULT_MEMORY_TEMPLATE = (projectName: string) => `# 🧠 AI Memory & Handoff — ${projectName}

### 🎯 Objetivo Atual
- Definir o que estamos desenvolvendo nesta funcionalidade.

### 🧭 Onde Paramos (Handoff)
- Descreva exatamente o ponto da última sessão para a próxima IA continuar sem dúvidas.

### ⚠️ O que Falhou / Abordagens Descartadas
- Registre erros encontrados e soluções que não funcionaram (evita que a IA repita o erro).

### 💡 Decisões Técnicas & Arquitetura
- Padrões de código, bibliotecas escolhidas e regras deste projeto.

### 📋 Próximos Passos
- [ ] Próxima tarefa imediata
- [ ] Teste ou validação pendente
`

export async function getProjectMemory(projectPath: string): Promise<ProjectMemory> {
  const memoryDir = path.join(projectPath, '.devorbit')
  const memoryFile = path.join(memoryDir, 'memory.md')
  const rootContextFile = path.join(projectPath, 'CONTEXT.md')

  try {
    const stat = await fs.stat(memoryFile)
    const content = await fs.readFile(memoryFile, 'utf-8')
    return {
      content,
      lastUpdated: stat.mtime.toISOString(),
      exists: true,
      path: memoryFile,
    }
  } catch {
    // Tenta fallback para CONTEXT.md na raiz se existir
    try {
      const stat = await fs.stat(rootContextFile)
      const content = await fs.readFile(rootContextFile, 'utf-8')
      return {
        content,
        lastUpdated: stat.mtime.toISOString(),
        exists: true,
        path: rootContextFile,
      }
    } catch {
      // Retorna template padrão
      const projectName = path.basename(projectPath)
      return {
        content: DEFAULT_MEMORY_TEMPLATE(projectName),
        exists: false,
        path: memoryFile,
      }
    }
  }
}

export async function saveProjectMemory(
  projectPath: string,
  content: string
): Promise<{ success: boolean; message?: string }> {
  try {
    const memoryDir = path.join(projectPath, '.devorbit')
    const memoryFile = path.join(memoryDir, 'memory.md')
    const rootContextFile = path.join(projectPath, 'CONTEXT.md')

    await fs.mkdir(memoryDir, { recursive: true })
    await fs.writeFile(memoryFile, content, 'utf-8')

    // Também sincroniza em CONTEXT.md na raiz do projeto para o Codex/Gemini ler nativamente
    try {
      await fs.writeFile(rootContextFile, content, 'utf-8')
    } catch {
      // Silencioso se não conseguir na raiz
    }

    return { success: true, message: 'Memória da IA salva com sucesso!' }
  } catch (err: any) {
    return { success: false, message: `Erro ao salvar memória: ${err.message}` }
  }
}

export async function generateMemoryFromGit(projectPath: string): Promise<string> {
  const projectName = path.basename(projectPath)
  const git = await getGitStatus(projectPath)
  const changes = await getGitChangesSummary(projectPath)

  let recentCommits = ''
  if (git.isRepo) {
    try {
      const { stdout } = await execAsync('git log -n 3 --oneline', {
        cwd: projectPath,
      })
      recentCommits = stdout.trim()
    } catch {
      // Sem commits ainda
    }
  }

  const lines: string[] = [
    `# 🧠 AI Memory & Handoff — ${projectName}`,
    ``,
    `### 🎯 Objetivo Atual`,
    `- Trabalhando na branch \`${git.isRepo ? git.branch : 'main'}\`.`,
  ]

  if (changes.length > 0) {
    lines.push(
      `- Alterações recentes em andamento nos arquivos:`,
      ...changes.slice(0, 5).map((c) => `  - \`${c}\``)
    )
  }

  lines.push(
    ``,
    `### 🧭 Onde Paramos (Handoff)`,
    `- Status do Git: ${git.isRepo ? git.statusMessage : 'Sem repositório Git configurado'}.`,
    recentCommits
      ? `- Últimos commits registrados:\n${recentCommits
          .split('\n')
          .map((c) => `  - ${c}`)
          .join('\n')}`
      : `- Nenhum commit recente.`,
    ``,
    `### ⚠️ O que Falhou / Abordagens Descartadas`,
    `- Registre aqui se algo não funcionou para a próxima IA não repetir o erro.`,
    ``,
    `### 💡 Decisões Técnicas & Arquitetura`,
    `- Projeto: \`${projectPath}\``,
    `- Mantenha as convenções de arquitetura já existentes no repositório.`,
    ``,
    `### 📋 Próximos Passos`,
    changes.length > 0
      ? `- [ ] Testar e validar as alterações pendentes nos ${changes.length} arquivos modificados`
      : `- [ ] Definir próxima funcionalidade`,
    `- [ ] Realizar commit e push para a branch \`${git.isRepo ? git.branch : 'main'}\``
  )

  return lines.join('\n')
}
