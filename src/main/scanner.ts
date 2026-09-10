import fs from 'node:fs/promises'
import path from 'node:path'
import type { Project, TechStack } from '../renderer/src/types'
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

export async function scanDirectoryForProjects(rootDir: string): Promise<Project[]> {
  const projects: Project[] = []

  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue

      const projectPath = path.join(rootDir, entry.name)

      try {
        const stats = await fs.stat(projectPath)
        if (!stats.isDirectory()) continue
        const hasGit = await isGitRepository(projectPath)
        const techs = await detectTechs(projectPath)

        // If in a dedicated projects folder or has git or has tech manifest, consider it a project
        const isProjectFolder =
          rootDir.toLowerCase().endsWith('projects') ||
          hasGit ||
          techs.length > 0

        if (isProjectFolder) {
          const git = await getGitStatus(projectPath)

          projects.push({
            id: Buffer.from(projectPath).toString('base64'),
            name: entry.name,
            path: projectPath,
            parentDir: path.basename(rootDir),
            lastModified: stats.mtimeMs,
            techs,
            git,
          })
        }
      } catch (err) {
        // Skip unreadable directories
        continue
      }
    }
  } catch (error) {
    console.error(`Erro ao ler diretório ${rootDir}:`, error)
  }

  return projects
}

export async function scanAllProjects(rootDirs: string[]): Promise<Project[]> {
  const allProjects: Project[] = []
  const seenPaths = new Set<string>()

  for (const rootDir of rootDirs) {
    const found = await scanDirectoryForProjects(rootDir)
    for (const p of found) {
      const normalized = p.path.toLowerCase()
      if (!seenPaths.has(normalized)) {
        seenPaths.add(normalized)
        allProjects.push(p)
      }
    }
  }

  // Sort by last modified descending
  allProjects.sort((a, b) => b.lastModified - a.lastModified)
  return allProjects
}
