import fs from 'node:fs/promises'
import path from 'node:path'
import type { ManagedProject, Project, TechStack } from '../renderer/src/types'
import { getGitStatus, isGitRepository } from './git'

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'bin',
  'obj',
  'target',
  'AppData',
  'Local Settings',
  'Application Data',
  'My Documents',
  'My Pictures',
  'My Music',
  'My Videos',
  '$RECYCLE.BIN',
  'System Volume Information',
])

const SCAN_CONCURRENCY = 4

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []

  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, Math.floor(limit)), items.length)

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

async function detectTechs(dirPath: string): Promise<TechStack[]> {
  const techs: TechStack[] = []

  const checkFile = async (fileName: string): Promise<boolean> => {
    try {
      await fs.access(path.join(dirPath, fileName))
      return true
    } catch {
      return false
    }
  }

  // Flutter / Dart
  if (await checkFile('pubspec.yaml')) {
    techs.push({ id: 'flutter', label: 'Flutter', color: '#02569B' })
  }

  // Node / JavaScript / TypeScript
  if (await checkFile('package.json')) {
    try {
      const content = await fs.readFile(path.join(dirPath, 'package.json'), 'utf-8')
      const pkg = JSON.parse(content)
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }

      if (deps['next']) {
        techs.push({ id: 'nextjs', label: 'Next.js', color: '#000000' })
      } else if (deps['react']) {
        techs.push({ id: 'react', label: 'React', color: '#149ECA' })
      } else if (deps['vue']) {
        techs.push({ id: 'vue', label: 'Vue', color: '#42B883' })
      } else {
        techs.push({ id: 'nodejs', label: 'Node.js', color: '#539E43' })
      }

      if (deps['typescript'] || await checkFile('tsconfig.json')) {
        techs.push({ id: 'typescript', label: 'TS', color: '#3178C6' })
      }
    } catch {
      techs.push({ id: 'nodejs', label: 'Node.js', color: '#539E43' })
    }
  }

  // Java
  if (await checkFile('pom.xml') || await checkFile('build.gradle') || await checkFile('mvnw') || await checkFile('gradlew')) {
    techs.push({ id: 'java', label: 'Java', color: '#EA2D2E' })
  }

  // Python
  if (await checkFile('requirements.txt') || await checkFile('pyproject.toml') || await checkFile('Pipfile') || await checkFile('main.py')) {
    techs.push({ id: 'python', label: 'Python', color: '#3776AB' })
  }

  // Rust
  if (await checkFile('Cargo.toml')) {
    techs.push({ id: 'rust', label: 'Rust', color: '#DEA584' })
  }

  // Go
  if (await checkFile('go.mod')) {
    techs.push({ id: 'go', label: 'Go', color: '#00ADD8' })
  }

  // Web HTML/CSS
  if (techs.length === 0 && (await checkFile('index.html'))) {
    techs.push({ id: 'web', label: 'Web/HTML', color: '#E34F26' })
  }

  return techs
}


interface ProjectMetadata {
  techs: TechStack[]
  packageManager?: string
  scripts: string[]
}

async function detectProjectMetadata(dirPath: string): Promise<ProjectMetadata> {
  const techs = await detectTechs(dirPath)
  let packageManager: string | undefined
  let scripts: string[] = []

  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(dirPath, 'package.json'), 'utf-8')) as {
      packageManager?: unknown
      scripts?: Record<string, unknown>
    }
    if (typeof packageJson.packageManager === 'string' && packageJson.packageManager.trim()) {
      packageManager = packageJson.packageManager.trim().split('@')[0]
    }
    const declaredScripts = packageJson.scripts && typeof packageJson.scripts === 'object'
      ? Object.keys(packageJson.scripts)
      : []
    const preferredScripts = ['dev', 'start', 'build', 'test', 'lint', 'typecheck', 'format', 'preview', 'check']
    scripts = preferredScripts.filter((script) => declaredScripts.includes(script)).slice(0, 6)
    if (!scripts.length) scripts = declaredScripts.slice(0, 6)
  } catch {
    // A project may be recognized by another manifest even when package.json
    // is absent or invalid.
  }

  if (!packageManager) {
    const lockFiles: Array<[string, string]> = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun'],
      ['package-lock.json', 'npm'],
      ['Cargo.toml', 'Cargo'],
      ['pubspec.yaml', 'Flutter'],
      ['pyproject.toml', 'Python'],
    ]
    for (const [fileName, manager] of lockFiles) {
      try {
        await fs.access(path.join(dirPath, fileName))
        packageManager = manager
        break
      } catch {
        // Try the next manifest.
      }
    }
  }

  return { techs, packageManager, scripts }
}

async function inspectProjectDirectory(
  realProjectPath: string,
  displayName: string,
  parentDir: string,
  refreshRemote: boolean,
  treatAsProject: boolean
): Promise<Project | null> {
  const stats = await fs.stat(realProjectPath)
  if (!stats.isDirectory()) return null

  const hasGit = await isGitRepository(realProjectPath)
  const metadata = await detectProjectMetadata(realProjectPath)
  if (!treatAsProject && !hasGit && metadata.techs.length === 0) return null

  const git = await getGitStatus(realProjectPath, refreshRemote)
  return {
    id: Buffer.from(realProjectPath).toString('base64'),
    name: displayName,
    path: realProjectPath,
    parentDir,
    lastModified: stats.mtimeMs,
    techs: metadata.techs,
    packageManager: metadata.packageManager,
    scripts: metadata.scripts,
    git,
    lifecycle: 'local',
  }
}

export async function scanDirectoryForProjects(rootDir: string, refreshRemote = false): Promise<Project[]> {
  try {
    // Resolve the configured root once. Apart from avoiding repeated I/O, this
    // keeps containment checks consistent when the configured path is a link.
    const realRoot = await fs.realpath(rootDir)
    const entries = await fs.readdir(realRoot, { withFileTypes: true })
    const candidateEntries = entries.filter(
      (entry) =>
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        !entry.name.startsWith('.') &&
        !IGNORED_DIRS.has(entry.name)
    )
    const treatChildrenAsProjects = rootDir.toLowerCase().endsWith('projects')

    const inspected = await mapWithConcurrency(
      candidateEntries,
      SCAN_CONCURRENCY,
      async (entry): Promise<Project | null> => {
        try {
          const projectPath = path.join(realRoot, entry.name)
          const realProjectPath = await fs.realpath(projectPath)
          const relative = path.relative(realRoot, realProjectPath)
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
          const stats = await fs.stat(realProjectPath)
          if (!stats.isDirectory()) return null
          const hasGit = await isGitRepository(realProjectPath)
          const metadata = await detectProjectMetadata(realProjectPath)
          const techs = metadata.techs

          // If in a dedicated projects folder or has git or has tech manifest, consider it a project
          const isProjectFolder =
            rootDir.toLowerCase().endsWith('projects') ||
            hasGit ||
            techs.length > 0

          if (isProjectFolder) {
            const git = await getGitStatus(realProjectPath, refreshRemote)

            return {
              id: Buffer.from(realProjectPath).toString('base64'),
              name: entry.name,
              path: realProjectPath,
              parentDir: path.basename(rootDir),
              lastModified: stats.mtimeMs,
              techs,
              packageManager: metadata.packageManager,
              scripts: metadata.scripts,
              git,
              parentPath: realRoot,
              lifecycle: 'local',
            }
          }

          return null
        } catch {
          // Skip unreadable or broken-link directories without aborting the
          // remaining scan workers.
          return null
        }
      }
    )

    const projects = inspected.filter((project): project is Project => project !== null)

    try {
      const rootProject = await inspectProjectDirectory(
        realRoot,
        path.basename(realRoot),
        path.basename(path.dirname(realRoot)),
        refreshRemote,
        false
      )
      if (rootProject && !projects.some((project) => project.path === rootProject.path)) {
        projects.unshift(rootProject)
      }
    } catch (error) {
      console.error(`Falha ao inspecionar a raiz ${realRoot}:`, error)
    }

    return projects
  } catch (error) {
    console.error(`Erro ao ler diretório ${rootDir}:`, error)
    return []
  }
}

export interface OtherDir {
  name: string
  path: string
  parentDir: string
}

export async function listNonProjectDirs(rootDir: string): Promise<OtherDir[]> {
  try {
    const realRoot = await fs.realpath(rootDir)
    const entries = await fs.readdir(realRoot, { withFileTypes: true })
    const candidateEntries = entries.filter(
      (entry) =>
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        !entry.name.startsWith('.') &&
        !IGNORED_DIRS.has(entry.name)
    )

    const inspected = await mapWithConcurrency(
      candidateEntries,
      SCAN_CONCURRENCY,
      async (entry): Promise<OtherDir | null> => {
        try {
          const projectPath = path.join(realRoot, entry.name)
          const realProjectPath = await fs.realpath(projectPath)
          const relative = path.relative(realRoot, realProjectPath)
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
          const stats = await fs.stat(realProjectPath)
          if (!stats.isDirectory()) return null
          if (await isGitRepository(realProjectPath)) return null
          if ((await detectTechs(realProjectPath)).length > 0) return null
          if (rootDir.toLowerCase().endsWith('projects')) return null
          return { name: entry.name, path: realProjectPath, parentDir: path.basename(rootDir) }
        } catch {
          return null
        }
      }
    )

    return inspected.filter((dir): dir is OtherDir => dir !== null)
  } catch (error) {
    console.error(`Erro ao ler diretório ${rootDir}:`, error)
    return []
  }
}

export async function listAllNonProjectDirs(rootDirs: string[]): Promise<OtherDir[]> {
  const allDirs: OtherDir[] = []
  const seenPaths = new Set<string>()

  for (const rootDir of rootDirs) {
    const found = await listNonProjectDirs(rootDir)
    for (const dir of found) {
      const normalized = dir.path.toLowerCase()
      if (!seenPaths.has(normalized)) {
        seenPaths.add(normalized)
        allDirs.push(dir)
      }
    }
  }

  allDirs.sort((a, b) => a.name.localeCompare(b.name))
  return allDirs
}

export async function scanAllProjects(
  rootDirs: string[],
  refreshRemote = false,
  managedProjects: ManagedProject[] = []
): Promise<Project[]> {
  const allProjects: Project[] = []
  const seenPaths = new Set<string>()

  for (const rootDir of rootDirs) {
    const found = await scanDirectoryForProjects(rootDir, refreshRemote)
    for (const p of found) {
      const normalized = p.path.toLowerCase()
      if (!seenPaths.has(normalized)) {
        seenPaths.add(normalized)
        allProjects.push(p)
      }
    }
  }

  // Keep a lightweight catalog entry after a working copy is released. Local
  // projects are enriched with the remote metadata; missing or empty folders
  // become archived placeholders that can be restored on demand.
  const byPath = new Map(allProjects.map((project) => [project.path.toLowerCase(), project]))
  const canonicalRoots = await Promise.all(rootDirs.map((rootDir) => fs.realpath(rootDir).catch(() => path.resolve(rootDir))))
  for (const managed of managedProjects) {
    const managedParent = await fs.realpath(managed.parentPath).catch(() => path.resolve(managed.parentPath))
    const belongsToConfiguredRoot = canonicalRoots.some((rootDir) => {
      const relative = path.relative(rootDir, managedParent)
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    })
    if (!belongsToConfiguredRoot) continue
    const expectedPath = await fs.realpath(path.resolve(managedParent, managed.folderName)).catch(() => path.resolve(managedParent, managed.folderName))
    const key = expectedPath.toLowerCase()
    const current = byPath.get(key)
    if (current) {
      current.remoteUrl = managed.remoteUrl
      current.parentPath = managedParent
      if (current.git.isRepo) {
        current.lifecycle = 'local'
      } else {
        try {
          const entries = await fs.readdir(current.path)
          if (entries.length === 0) {
            current.lifecycle = 'archived'
            current.git.statusMessage = 'Projeto arquivado — conteúdo não baixado'
            current.git.branch = managed.branch
          }
        } catch {
          // Keep the scanned project visible if the folder disappears mid-scan.
        }
      }
      continue
    }

    let archived = true
    let actualPath = expectedPath
    try {
      actualPath = await fs.realpath(expectedPath)
      const entries = await fs.readdir(actualPath)
      archived = entries.length === 0
    } catch {
      // A missing directory is still a valid catalog entry; restore will create it.
    }
    if (!archived) continue
    const placeholder: Project = {
      id: managed.id,
      name: managed.name,
      path: actualPath,
      parentDir: path.basename(managedParent),
      parentPath: managedParent,
      lastModified: Date.parse(managed.registeredAt) || Date.now(),
      techs: [],
      remoteUrl: managed.remoteUrl,
      lifecycle: 'archived',
      git: {
        isRepo: false,
        branch: managed.branch,
        ahead: 0,
        behind: 0,
        hasChanges: false,
        modifiedCount: 0,
        untrackedCount: 0,
        statusMessage: 'Projeto arquivado — conteúdo não baixado',
      },
    }
    allProjects.push(placeholder)
    byPath.set(key, placeholder)
  }

  // Sort by last modified descending
  allProjects.sort((a, b) => b.lastModified - a.lastModified)
  return allProjects
}
