/** Private scratch marker, mode, resume, and path-ownership behavior. */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ScienceRunId } from '@deepseek-ai/dsh-science-session'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import {
  createProbeScratch,
  createRunScratch,
  ensureSessionScratch,
  removeProbeScratch,
  scienceSessionScratchRoot,
  sessionScratchKey,
} from '../src/scratch.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Create an otherwise minimal durable Session for a private-scratch operation. */
async function sessionWithId(id: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  return ctx.sessions.create(SessionId(id))
}

/** Assert a managed directory uses the exact private POSIX mode. */
function expectPrivateDirectory(path: string): void {
  const entry = lstatSync(path)
  expect(entry.isDirectory()).toBe(true)
  expect(entry.isSymbolicLink()).toBe(false)
  expect(entry.mode & 0o777).toBe(0o700)
}

/** Assert a managed regular file uses the exact private POSIX mode. */
function expectPrivateFile(path: string): void {
  const entry = lstatSync(path)
  expect(entry.isFile()).toBe(true)
  expect(entry.isSymbolicLink()).toBe(false)
  expect(entry.mode & 0o777).toBe(0o600)
}

describe('Science Runtime private scratch', () => {
  it('creates mode-private marker and Session paths, resumes a same-ID Session, and separates a fork', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-scratch-'))
    roots.push(root)
    const dshHome = join(root, 'science home with space')
    const original = await sessionWithId('science-scratch-resume')
    const scratch = await ensureSessionScratch(dshHome, original)
    const key = sessionScratchKey(original)
    const marker = join(dshHome, 'science', 'v1', 'owners', `${key}.json`)

    expect(readFileSync(marker, 'utf8')).toBe(JSON.stringify({
      version: 1, key, sessionId: 'science-scratch-resume',
    }))
    for (const path of [scratch.root, scratch.home, scratch.state, scratch.runs, scratch.probes]) {
      expectPrivateDirectory(path)
    }
    expectPrivateFile(marker)

    const resumed = await sessionWithId('science-scratch-resume')
    expect(await ensureSessionScratch(dshHome, resumed)).toEqual(scratch)
    const fork = await sessionWithId('science-scratch-fork')
    const forkScratch = await ensureSessionScratch(dshHome, fork)
    expect(forkScratch.root).not.toBe(scratch.root)
    expectPrivateDirectory(forkScratch.root)
  })

  it('recovers an exact marker-only crash point but fails closed for collisions or a root without its marker', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-owner-'))
    roots.push(root)
    const dshHome = join(root, 'dsh-home')
    const session = await sessionWithId('science-owner-collision')
    const scratch = await ensureSessionScratch(dshHome, session)
    const marker = join(dshHome, 'science', 'v1', 'owners', `${sessionScratchKey(session)}.json`)

    writeFileSync(marker, JSON.stringify({ version: 1, key: 'wrong', sessionId: 'other' }))
    chmodSync(marker, 0o600)
    await expect(ensureSessionScratch(dshHome, session)).rejects.toThrow(/owner marker does not match/)

    writeFileSync(marker, JSON.stringify({ version: 1, key: sessionScratchKey(session), sessionId: String(session.id) }))
    chmodSync(marker, 0o600)
    rmSync(scratch.root, { recursive: true })
    const recovered = await ensureSessionScratch(dshHome, session)
    expect(recovered.root).toBe(scratch.root)
    expectPrivateDirectory(recovered.root)

    unlinkSync(marker)
    await expect(ensureSessionScratch(dshHome, session)).rejects.toThrow(/must appear together/)
    expectPrivateDirectory(scratch.root)
  })

  it('rejects an unexpected symlink and writes exact private source bytes for a retained run', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-source-'))
    roots.push(root)
    const dshHome = join(root, 'dsh-home')
    const session = await sessionWithId('science-source-ownership')
    const scratch = await ensureSessionScratch(dshHome, session)
    const bytes = Buffer.from('print("运行-✓")\n', 'utf8')
    const run = await createRunScratch(
      scratch,
      ScienceRunId('00000000-0000-4000-8000-000000000001'),
      'python',
      bytes,
    )

    expect(readFileSync(run.source)).toEqual(bytes)
    expectPrivateDirectory(run.directory)
    expectPrivateDirectory(run.tmp)
    expectPrivateDirectory(run.artifacts)
    expectPrivateFile(run.source)

    rmSync(scratch.home, { recursive: true })
    const foreign = join(root, 'foreign-home')
    mkdirSync(foreign, { mode: 0o700 })
    symlinkSync(foreign, scratch.home)
    await expect(ensureSessionScratch(dshHome, session)).rejects.toThrow(/private directory/)
  })

  it('removes only a quiescent provider-owned probe and rejects a generic-temp scratch root', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-probe-'))
    roots.push(root)
    const session = await sessionWithId('science-probe-cleanup')
    const scratch = await ensureSessionScratch(join(root, 'dsh-home'), session)
    const probe = await createProbeScratch(scratch)
    expectPrivateDirectory(probe.directory)
    await removeProbeScratch(scratch, probe)
    expect(existsSync(probe.directory)).toBe(false)
    expectPrivateDirectory(scratch.home)

    const tempSession = await sessionWithId('science-temp-root')
    await expect(scienceSessionScratchRoot(join('/tmp', 'science-runtime-negative'), tempSession))
      .rejects.toThrow(/must not overlap/)
  })
})
