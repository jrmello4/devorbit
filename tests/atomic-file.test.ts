import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { recoverFileFromBackup, restoreFileFromBackup, writeFileAtomically } from '../src/main/atomic-file'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('atomic file persistence', () => {
  it('keeps the previous content when recovering a replacement backup', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-atomic-'))
    directories.push(directory)
    const filePath = path.join(directory, 'history.json')
    const backupPath = path.join(directory, 'history.json.123.456.bak')
    await fs.writeFile(backupPath, 'previous\n', 'utf8')

    expect(await recoverFileFromBackup(filePath)).toBe(true)
    expect(await fs.readFile(filePath, 'utf8')).toBe('previous\n')
  })

  it('writes the replacement only after the temporary file is durable', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-atomic-'))
    directories.push(directory)
    const filePath = path.join(directory, 'history.json')
    await writeFileAtomically(filePath, 'next\n')

    expect(await fs.readFile(filePath, 'utf8')).toBe('next\n')
    expect((await fs.readdir(directory)).filter((entry) => entry.endsWith('.tmp') || entry.endsWith('.bak'))).toEqual([])
  })

  it('keeps the previous version as a backup and recovers it when the main file disappears', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-atomic-'))
    directories.push(directory)
    const filePath = path.join(directory, 'history.json')
    await writeFileAtomically(filePath, 'v1\n')
    await writeFileAtomically(filePath, 'v2\n')

    expect(await fs.readFile(filePath, 'utf8')).toBe('v2\n')
    expect(await fs.readFile(`${filePath}.bak`, 'utf8')).toBe('v1\n')

    await fs.rm(filePath, { force: true })
    expect(await recoverFileFromBackup(filePath)).toBe(true)
    expect(await fs.readFile(filePath, 'utf8')).toBe('v1\n')
  })

  it('restores a corrupt file from backup and quarantines the corrupt copy', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devorbit-atomic-'))
    directories.push(directory)
    const filePath = path.join(directory, 'history.json')
    await writeFileAtomically(filePath, 'v1\n')
    await writeFileAtomically(filePath, 'v2\n')
    await fs.writeFile(filePath, '{broken', 'utf8')

    expect(await restoreFileFromBackup(filePath, { overwrite: true })).toBe(true)
    expect(await fs.readFile(filePath, 'utf8')).toBe('v1\n')
    const entries = await fs.readdir(directory)
    expect(entries.some((entry) => entry.startsWith('history.json.corrupt-'))).toBe(true)
  })
})
