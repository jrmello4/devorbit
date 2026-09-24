import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  deriveAiMemoryIdentity,
  detectRemoteUrl,
  normalizeRemoteUrl,
  parseAiMemoryMarker,
  readAiMemoryMarker,
  renderAiMemoryMarker,
  resolveAiMemoryScope,
  writeAiMemoryMarker,
  type AiMemoryFileSystem,
} from '../src/main/ai-memory-scope'
import { AI_MEMORY_MARKER_MANAGED_HEADER } from '../src/shared/ai-memory-contract'

const execFileSpies = vi.hoisted(() => ({ calls: [] as Array<{ command: string; args: string[]; options: unknown }> }))
vi.mock('node:child_process', () => ({
  execFile: (command: string, args: readonly string[], options: unknown, callback: unknown) => {
    execFileSpies.calls.push({ command, args: [...args], options })
    const cb = callback as (error: Error | null, result: { stdout: string; stderr: string }) => void
    queueMicrotask(() => cb(null, { stdout: 'origin\n', stderr: '' }))
  },
}))

function createMemoryFs(seed: Record<string, string> = {}): {
  fs: AiMemoryFileSystem
  files: Map<string, Buffer>
} {
  const files = new Map<string, Buffer>()
  const dirs = new Set<string>()
  const key = (value: string): string => path.resolve(value).toLowerCase()
  for (const [filePath, content] of Object.entries(seed)) {
    files.set(key(filePath), Buffer.from(content))
  }
  const missing = (): NodeJS.ErrnoException => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    return error
  }
  const fs: AiMemoryFileSystem = {
    readFile: async (filePath) => {
      const value = files.get(key(filePath))
      if (!value) throw missing()
      return Buffer.from(value)
    },
    writeFile: async (filePath, data) => {
      files.set(key(filePath), Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data))
    },
    mkdir: async (dirPath) => {
      dirs.add(key(dirPath))
    },
    stat: async (filePath) => {
      const value = files.get(key(filePath))
      if (value) return { isFile: () => true, isDirectory: () => false, size: value.length }
      if (dirs.has(key(filePath))) return { isFile: () => false, isDirectory: () => true, size: 0 }
      throw missing()
    },
    rm: async (filePath) => {
      files.delete(key(filePath))
      dirs.delete(key(filePath))
    },
    rename: async (from, to) => {
      const value = files.get(key(from))
      if (!value) throw missing()
      files.delete(key(from))
      files.set(key(to), value)
    },
    access: async (filePath) => {
      if (!files.has(key(filePath)) && !dirs.has(key(filePath))) throw missing()
    },
    realpath: async (filePath) => path.resolve(filePath),
  }
  return { fs, files }
}

describe('ai-memory remote normalization and identity', () => {
  it('normaliza https, ssh e scp-like para a mesma chave', () => {
    const https = normalizeRemoteUrl('https://github.com/Acme/Repo.git')
    const ssh = normalizeRemoteUrl('ssh://git@github.com/Acme/Repo.git')
    const scp = normalizeRemoteUrl('git@github.com:Acme/Repo.git')
    expect(https).toBe('github.com/acme/repo')
    expect(ssh).toBe(https)
    expect(scp).toBe(https)
  })

  it('remove credenciais e rejeita valores vazios', () => {
    expect(normalizeRemoteUrl('https://user:pass@github.com/acme/repo')).toBe('github.com/acme/repo')
    expect(normalizeRemoteUrl('')).toBeUndefined()
    expect(normalizeRemoteUrl(42)).toBeUndefined()
  })

  it('mesmo remoto = mesma identidade; remotos diferentes com mesmo basename colidem? não', () => {
    const a = deriveAiMemoryIdentity({ projectPath: '/w/a', remoteUrl: 'https://github.com/acme/repo.git' })
    const b = deriveAiMemoryIdentity({ projectPath: '/w/b', remoteUrl: 'git@github.com:acme/repo.git' })
    const c = deriveAiMemoryIdentity({ projectPath: '/w/c', remoteUrl: 'https://github.com/other/repo.git' })
    expect(a.identity).toBe(b.identity)
    expect(c.identity).not.toBe(a.identity)
    expect(a.source).toBe('remote')
  })

  it('worktrees do mesmo checkout (common-dir igual) compartilham identidade', () => {
    const main = deriveAiMemoryIdentity({ projectPath: '/repo', gitCommonDir: '/repo/.git' })
    const worktree = deriveAiMemoryIdentity({ projectPath: '/repo-feature', gitCommonDir: '/repo/.git' })
    expect(main.identity).toBe(worktree.identity)
    expect(main.source).toBe('git-common-dir')
  })

  it('mesmo remote com common-dir distinto NÃO funde clones independentes', () => {
    const cloneA = deriveAiMemoryIdentity({
      projectPath: '/clone-a',
      remoteUrl: 'https://github.com/acme/repo.git',
      gitCommonDir: '/clone-a/.git',
    })
    const cloneB = deriveAiMemoryIdentity({
      projectPath: '/clone-b',
      remoteUrl: 'git@github.com:acme/repo.git',
      gitCommonDir: '/clone-b/.git',
    })
    expect(cloneA.identity).not.toBe(cloneB.identity)
    expect(cloneA.source).toBe('git-common-dir')
  })

  it('sem common-dir, o remote normalizado é o fallback de identidade', () => {
    const a = deriveAiMemoryIdentity({ projectPath: '/a', remoteUrl: 'https://github.com/acme/repo.git' })
    const b = deriveAiMemoryIdentity({ projectPath: '/b', remoteUrl: 'git@github.com:acme/repo.git' })
    expect(a.identity).toBe(b.identity)
    expect(a.source).toBe('remote')
  })

  it('sem remoto e sem git, cai para o path resolvido', () => {
    const first = deriveAiMemoryIdentity({ projectPath: '/repo' })
    const second = deriveAiMemoryIdentity({ projectPath: '/repo/' })
    expect(first.identity).toBe(second.identity)
    expect(first.source).toBe('path')
  })
})

describe('ai-memory scope resolution', () => {
  it('usa workspace devorbit e project explícito do marker', () => {
    const scope = resolveAiMemoryScope({
      projectPath: '/repo',
      remoteUrl: 'https://github.com/acme/repo.git',
      marker: { project: 'pe-portais' },
    })
    expect(scope.workspace).toBe('devorbit')
    expect(scope.project).toBe('pe-portais')
    expect(scope.source).toBe('marker')
  })

  it('deriva project determinístico quando o marker não declara', () => {
    const scope = resolveAiMemoryScope({ projectPath: '/repo', remoteUrl: 'https://github.com/acme/repo.git' })
    expect(scope.project).toMatch(/^p-[a-f0-9]{16}$/)
    expect(scope.project).toBe(
      resolveAiMemoryScope({ projectPath: '/other', remoteUrl: 'https://github.com/acme/repo.git' }).project
    )
  })
})

describe('ai-memory marker', () => {
  it('renderiza e reparseia workspace/project/strategy/briefing/capture', () => {
    const rendered = renderAiMemoryMarker({
      workspace: 'devorbit',
      project: 'p-abc',
      projectStrategy: 'repo-root',
      briefing: { injectOnSessionStart: true, maxChars: 4000 },
      ignorePaths: ['.devorbit/**', '.git/**'],
    })
    const parsed = parseAiMemoryMarker(rendered)
    expect(parsed.workspace).toBe('devorbit')
    expect(parsed.project).toBe('p-abc')
    expect(parsed.projectStrategy).toBe('repo-root')
    expect(parsed.briefing).toEqual({ injectOnSessionStart: true, maxChars: 4000 })
    expect(parsed.ignorePaths).toEqual(['.devorbit/**', '.git/**'])
  })

  it('cria e é idempotente; preferência divergente vira conflict sem escrita', async () => {
    const { fs } = createMemoryFs()
    const marker = { workspace: 'devorbit', project: 'p-abc', projectStrategy: 'repo-root' as const }
    const created = await writeAiMemoryMarker('/repo', marker, { fs })
    expect(created.status).toBe('created')
    const unchanged = await writeAiMemoryMarker('/repo', marker, { fs })
    expect(unchanged.status).toBe('unchanged')
    const before = (await fs.readFile(path.join('/repo', '.ai-memory.toml'))).toString('utf8')
    const divergent = await writeAiMemoryMarker(
      '/repo',
      { ...marker, briefing: { maxChars: 2000 } },
      { fs }
    )
    expect(divergent.status).toBe('conflict')
    expect(divergent.conflicts).toContain('briefing.max_chars')
    const after = (await fs.readFile(path.join('/repo', '.ai-memory.toml'))).toString('utf8')
    expect(after).toBe(before)
  })

  it('preserva exclusões customizadas do usuário (conflict, sem reescrita)', async () => {
    const custom = renderAiMemoryMarker({
      workspace: 'devorbit',
      project: 'p-abc',
      projectStrategy: 'repo-root',
      briefing: { injectOnSessionStart: true, maxChars: 4000 },
      ignorePaths: ['.devorbit/**', '.git/**', 'private/**'],
    })
    const { fs } = createMemoryFs({ [path.join('/repo', '.ai-memory.toml')]: custom })
    const result = await writeAiMemoryMarker(
      '/repo',
      {
        workspace: 'devorbit',
        project: 'p-abc',
        projectStrategy: 'repo-root',
        briefing: { injectOnSessionStart: true, maxChars: 4000 },
        ignorePaths: ['.devorbit/**', '.git/**'],
      },
      { fs }
    )
    expect(result.status).toBe('conflict')
    expect(result.conflicts).toContain('ignore_paths')
    const raw = (await fs.readFile(path.join('/repo', '.ai-memory.toml'))).toString('utf8')
    expect(raw).toBe(custom)
  })

  it('preserva marker de terceiros sem conflito e recusa conflito', async () => {
    const thirdParty = 'workspace = "devorbit"\n'
    const preservedFs = createMemoryFs({ [path.join('/repo', '.ai-memory.toml')]: thirdParty })
    const preserved = await writeAiMemoryMarker(
      '/repo',
      { workspace: 'devorbit', project: 'p-abc' },
      { fs: preservedFs.fs }
    )
    expect(preserved.status).toBe('preserved')

    const conflictFs = createMemoryFs({ [path.join('/repo', '.ai-memory.toml')]: 'workspace = "outro"\n' })
    const conflict = await writeAiMemoryMarker(
      '/repo',
      { workspace: 'devorbit', project: 'p-abc' },
      { fs: conflictFs.fs }
    )
    expect(conflict.status).toBe('conflict')
    expect(conflict.conflicts).toContain('workspace')
  })

  it('lê marker existente', async () => {
    const { fs } = createMemoryFs({ [path.join('/repo', '.ai-memory.toml')]: 'workspace = "devorbit"\nproject = "x"\n' })
    const result = await readAiMemoryMarker('/repo', { fs })
    expect(result.exists).toBe(true)
    expect(result.marker?.project).toBe('x')
  })

  it('só trata o cabeçalho DevOrbit como primeira linha significativa', async () => {
    const thirdParty = `workspace = "devorbit"\n# see ${AI_MEMORY_MARKER_MANAGED_HEADER} for details\n`
    const { fs } = createMemoryFs({ [path.join('/repo', '.ai-memory.toml')]: thirdParty })
    const result = await writeAiMemoryMarker('/repo', { workspace: 'devorbit', project: 'p-abc' }, { fs })
    expect(result.status).toBe('preserved')
    expect(result.configured).toBe(false)
  })

  it('marker gerenciado com extras do usuário retorna conflict e não é alterado', async () => {
    const managed = `${AI_MEMORY_MARKER_MANAGED_HEADER}\nworkspace = "devorbit"\nproject = "p-abc"\n[recall]\ndefault_global = "true"\n`
    const { fs } = createMemoryFs({ [path.join('/repo', '.ai-memory.toml')]: managed })
    const result = await writeAiMemoryMarker(
      '/repo',
      { workspace: 'devorbit', project: 'p-abc', briefing: { maxChars: 4000 } },
      { fs }
    )
    expect(result.status).toBe('conflict')
    expect(result.conflicts).toContain('extra-content')
    const raw = (await fs.readFile(path.join('/repo', '.ai-memory.toml'))).toString('utf8')
    expect(raw).toBe(managed)
  })

  it('falha na substituição preserva o conteúdo original e limpa temporários', async () => {
    // Semântica idêntica ao desejado (só formatação difere) para atingir a
    // escrita atômica sem disparar conflito de preferência.
    const original = `${AI_MEMORY_MARKER_MANAGED_HEADER}\n\nworkspace = "devorbit"\nproject = "p-abc"\n`
    const base = createMemoryFs({ [path.join('/repo', '.ai-memory.toml')]: original })
    const failing: AiMemoryFileSystem = {
      ...base.fs,
      rename: async (from, to) => {
        if (from.endsWith('.tmp') && to.endsWith('.ai-memory.toml')) {
          const error = new Error('EPERM') as NodeJS.ErrnoException
          error.code = 'EPERM'
          throw error
        }
        await base.fs.rename(from, to)
      },
    }
    await expect(
      writeAiMemoryMarker('/repo', { workspace: 'devorbit', project: 'p-abc' }, { fs: failing })
    ).rejects.toThrow(/EPERM/)
    const raw = (await failing.readFile(path.join('/repo', '.ai-memory.toml'))).toString('utf8')
    expect(raw).toBe(original)
    const leftovers = [...base.files.keys()].filter((key) => key.endsWith('.tmp') || key.endsWith('.bak'))
    expect(leftovers).toEqual([])
  })
})

describe('defaultGitRunner do scope — env mínimo (sem herdar segredos do main)', () => {
  it('detectRemoteUrl com runner default usa env allowlist e não recebe sentinela secreta', async () => {
    const previous = process.env.SCOPE_SECRET_SENTINEL
    process.env.SCOPE_SECRET_SENTINEL = 'sk-scope-secret-456'
    try {
      execFileSpies.calls.length = 0
      const remote = await detectRemoteUrl('/repo')
      expect(remote).toBe('origin')
      expect(execFileSpies.calls).toHaveLength(1)
      const call = execFileSpies.calls[0]
      expect(call.command).toBe('git')
      expect(call.args).toEqual(['remote', 'get-url', 'origin'])
      const options = call.options as { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean }
      // O host Windows usa `Path` — assert case-insensitive.
      const envKey = (name: string): string | undefined =>
        Object.keys(options.env).find((key) => key.toLowerCase() === name.toLowerCase())
      expect(envKey('PATH')).toBeDefined()
      expect(envKey('SystemRoot')).toBeDefined()
      expect(options.timeout).toBe(8000)
      expect(options.windowsHide).toBe(true)
      // Nem o segredo bruto nem chave secreta conhecida entram no subprocesso.
      expect(JSON.stringify(options.env)).not.toContain('sk-scope-secret-456')
      expect(envKey('OPENAI_API_KEY')).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.SCOPE_SECRET_SENTINEL
      else process.env.SCOPE_SECRET_SENTINEL = previous
    }
  })
})
