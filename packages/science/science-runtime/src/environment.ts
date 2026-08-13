/** Stable local Conda-prefix observation through the shared subprocess and sandbox services. */

import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { canonicalizeWatchPath } from '@deepseek-ai/dsh-home-paths'
import type { ScienceInterpreterBinding, ScienceLanguage } from '@deepseek-ai/dsh-science-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ScienceRuntimeError } from './types.ts'
import type { ConfiguredProfile } from './config.ts'
import { containsPath, createProbeScratch, pathsOverlap, removeProbeScratch } from './scratch.ts'
import type { ScienceProbeScratch, ScienceSessionScratch } from './scratch.ts'

const VERSION_MAX_BYTES = 1_024
const UTF8_PROBE_TEXT = 'dsh-科学-✓'
const UNIX_EXECUTE_BITS = 0o111

/** Stable facts required to start a selected interpreter. */
export interface ObservedInterpreter {
  /** Durable binding result. */
  readonly binding: ScienceInterpreterBinding
  /** Canonical prefix used in fixed PATH and boundary comparisons. */
  readonly prefix: string
  /** Canonical executable used in direct argv. */
  readonly executable: string
}

/** Stable observations for every configured language in one profile. */
export interface ObservedProfile {
  /** Configured durable profile id. */
  readonly profile: ConfiguredProfile
  /** Python observation when declared. */
  readonly python?: ObservedInterpreter
  /** R observation when declared. */
  readonly r?: ObservedInterpreter
}

/** Input services and static values for a stable observation. */
export interface ObservationServices {
  readonly subprocess: SubprocessRuntime
  readonly sandbox: SandboxProvider
  readonly sessionScratch: ScienceSessionScratch
  readonly sessionId: SessionId
  readonly signal: AbortSignal
}

/** Canonical direct argv for an interpreter version or Unicode proof. */
function probeArgv(language: ScienceLanguage, executable: string, kind: 'version' | 'utf8'): string[] {
  if (language === 'python') {
    return kind === 'version'
      ? [executable, '-I', '-B', '-X', 'utf8', '--version']
      : [executable, '-I', '-B', '-X', 'utf8', '-c', 'import sys;sys.stdout.buffer.write("dsh-科学-✓".encode("utf-8"))']
  }
  return kind === 'version'
    ? [executable, '--vanilla', '--encoding=UTF-8', '--version']
    : [executable, '--vanilla', '--encoding=UTF-8', '-e', 'cat(enc2utf8("dsh-科学-✓"),sep="")']
}

/** Fixed locale for a supported POSIX host. */
function localeEnvironment(): Pick<NodeJS.ProcessEnv, 'LANG' | 'LC_ALL' | 'TZ'> {
  return {
    LANG: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
    LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
    TZ: 'UTC',
  }
}

/** Exact child environment for an unpublished probe. */
function probeEnvironment(prefix: string, scratch: ScienceProbeScratch): NodeJS.ProcessEnv {
  return {
    HOME: scratch.home,
    TMPDIR: scratch.tmp,
    PATH: process.platform === 'win32' ? join(prefix, 'Scripts') : `${join(prefix, 'bin')}:/usr/bin:/bin`,
    ...localeEnvironment(),
  }
}

/** A private probe policy owned by exactly one provider observation. */
function probePolicy(scratch: ScienceProbeScratch, sessionId: SessionId): SandboxPolicy {
  return { mode: 'workspace-write', workspaceRoot: scratch.directory, sessionId }
}

/** Reject a prefix that falls inside or contains a writable root. */
function rejectWritableOverlap(prefix: string, policy: SandboxPolicy): void {
  for (const root of writableRoots(policy)) {
    if (pathsOverlap(prefix, root)) {
      throw new ScienceRuntimeError('CONFINEMENT_UNAVAILABLE', 'configured Conda prefix overlaps a sandbox writable root')
    }
  }
}

/**
 * Reject an allowlisted prefix that a future fixed run policy could write.
 * @param profile - Selected local profile before any scratch creation.
 * @param session - Exact live Session that would own the policy.
 * @param scratchRoot - Derived but not yet created Science Session root.
 */
export async function assertProfileRunConfinement(
  profile: ConfiguredProfile,
  session: Session,
  scratchRoot: string,
): Promise<void> {
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: scratchRoot, sessionId: session.id }
  for (const prefix of [profile.pythonPrefix, profile.rPrefix]) {
    if (prefix !== undefined) rejectWritableOverlap(await canonicalizeWatchPath(prefix), policy)
  }
}

/** Return the platform executable candidate for a configured language prefix. */
function executableCandidate(language: ScienceLanguage, prefix: string): string {
  if (process.platform === 'win32') {
    return language === 'python' ? join(prefix, 'python.exe') : join(prefix, 'Scripts', 'Rscript.exe')
  }
  return join(prefix, 'bin', language === 'python' ? 'python' : 'Rscript')
}

/** Convert one fs bigint stat into the frozen executable identity serialization. */
function executableIdentity(info: Awaited<ReturnType<typeof stat>>): string {
  const asBigInt = info as Awaited<ReturnType<typeof stat>> & {
    readonly dev: bigint
    readonly ino: bigint
    readonly mode: bigint
    readonly size: bigint
    readonly mtimeNs: bigint
    readonly ctimeNs: bigint
  }
  return `stat-v1\0${process.platform}\0${String(asBigInt.dev)}\0${String(asBigInt.ino)}\0${String(asBigInt.mode)}\0${String(asBigInt.size)}\0${String(asBigInt.mtimeNs)}\0${String(asBigInt.ctimeNs)}`
}

/** Lower-case SHA-256 for one exact byte or string sequence. */
function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Normalize a lossless version capture to exactly one non-empty line. */
function normalizeVersion(stdout: string, stderr: string): string | undefined {
  const selected = stdout.length > 0 ? stdout : stderr
  if (stdout.length > 0 && stderr.length > 0) return undefined
  const value = selected.replaceAll('\r\n', '\n').replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, '')
  if (value.length === 0 || value.includes('\0') || value.split('\n').length !== 1) return undefined
  return value
}

/** Run one fully confined direct argv probe and return exact retained bytes/text facts. */
async function runProbe(
  services: ObservationServices,
  prefix: string,
  scratch: ScienceProbeScratch,
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string; readonly ok: boolean }> {
  const policy = probePolicy(scratch, services.sessionId)
  rejectWritableOverlap(prefix, policy)
  const confined = services.sandbox.confine(argv, policy)
  if (confined.enforcement !== 'full') {
    throw new ScienceRuntimeError('CONFINEMENT_UNAVAILABLE', 'Science requires full sandbox enforcement')
  }
  const handle = services.subprocess.spawn({
    argv: confined.argv,
    cwd: scratch.directory,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: VERSION_MAX_BYTES },
      stderr: { maxBytes: VERSION_MAX_BYTES },
    },
    graceMs: 3_000,
    environmentBase: 'empty',
    env: probeEnvironment(prefix, scratch),
    signal: services.signal,
  })
  let outcome: Awaited<typeof handle.done> | undefined
  let completionError: unknown
  try {
    outcome = await handle.done
  } catch (error) {
    completionError = error
  }
  // Caller cancellation already asks the shared subprocess provider to
  // terminate; cleanup waits without the caller signal so the probe directory
  // is never removed while a managed tree still owns it.
  const quiescent = await handle.waitForExit()
  if (!quiescent) throw new ScienceRuntimeError('QUIESCENCE_UNPROVEN', 'interpreter probe did not reach whole-tree quiescence')
  if (completionError !== undefined) {
    if (completionError instanceof Error) throw completionError
    throw new Error('science-runtime: interpreter probe failed without an Error object')
  }
  if (outcome === undefined) throw new Error('science-runtime: probe settled without a subprocess outcome')
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined || stdout.lossy || stderr.lossy
    || stdout.utf8Validity !== 'valid' || stderr.utf8Validity !== 'valid') {
    return { stdout: '', stderr: '', ok: false }
  }
  return { stdout: stdout.text, stderr: stderr.text, ok: outcome.exitCode === 0 && outcome.signal === null }
}

/** Distinguish an absent or structurally unusable configured interpreter from provider I/O failure. */
class StaticInterpreterUnavailableError extends Error {
  override name = 'StaticInterpreterUnavailableError'
}

/** Convert an ordinary missing path into an honest invalid binding, preserving other I/O failures. */
function unavailableOnMissing(error: unknown, description: string): never {
  const code = typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    throw new StaticInterpreterUnavailableError(description)
  }
  throw error
}

/** Check static prefix and executable facts before any child starts. */
async function staticInterpreter(
  language: ScienceLanguage,
  configuredPrefix: string,
): Promise<{ readonly prefix: string; readonly executable: string; readonly history: Uint8Array; readonly identity: string }> {
  let prefix: string
  try {
    prefix = await realpath(configuredPrefix)
  } catch (error) {
    unavailableOnMissing(error, 'configured Conda prefix is absent or cannot be resolved')
  }
  const historyPath = join(prefix, 'conda-meta', 'history')
  let historyInfo: Awaited<ReturnType<typeof lstat>>
  try {
    historyInfo = await lstat(historyPath)
  } catch (error) {
    unavailableOnMissing(error, 'conda-meta/history is absent')
  }
  if (!historyInfo.isFile() || historyInfo.isSymbolicLink()) {
    throw new StaticInterpreterUnavailableError('conda-meta/history must be a regular file')
  }
  let executable: string
  try {
    executable = await realpath(executableCandidate(language, prefix))
  } catch (error) {
    unavailableOnMissing(error, `configured ${language} interpreter is absent`)
  }
  if (!containsPath(prefix, executable)) throw new StaticInterpreterUnavailableError('interpreter escapes configured prefix')
  let executableInfo: Awaited<ReturnType<typeof lstat>>
  try {
    executableInfo = await lstat(executable)
  } catch (error) {
    unavailableOnMissing(error, `configured ${language} interpreter is absent`)
  }
  if (!executableInfo.isFile() || executableInfo.isSymbolicLink()
    || (process.platform !== 'win32' && (executableInfo.mode & UNIX_EXECUTE_BITS) === 0)) {
    throw new StaticInterpreterUnavailableError('interpreter is not a regular executable')
  }
  let identity: string
  let history: Uint8Array
  try {
    identity = executableIdentity(await stat(executable, { bigint: true }))
    history = await readFile(historyPath)
  } catch (error) {
    unavailableOnMissing(error, 'configured interpreter changed during static observation')
  }
  return { prefix, executable, history, identity }
}

/** Build an honest static invalid record without creating a probe directory. */
function staticFailure(language: ScienceLanguage, configuredPrefix: string, error: unknown): ObservedInterpreter {
  const detail = error instanceof Error ? error.message : String(error)
  const reason = detail.slice(0, 1_024)
  return {
    prefix: configuredPrefix,
    executable: executableCandidate(language, configuredPrefix),
    binding: { language, configuredPrefix, capability: 'invalid', reason },
  }
}

/** Execute the frozen two-probe observation and calculate its binding digest. */
async function observeStable(
  services: ObservationServices,
  language: ScienceLanguage,
  configuredPrefix: string,
): Promise<ObservedInterpreter> {
  let staticFacts: Awaited<ReturnType<typeof staticInterpreter>>
  try {
    staticFacts = await staticInterpreter(language, configuredPrefix)
  } catch (error) {
    if (error instanceof StaticInterpreterUnavailableError) {
      return staticFailure(language, configuredPrefix, error)
    }
    throw error
  }
  if (process.platform === 'win32') {
    throw new ScienceRuntimeError('CONFINEMENT_UNAVAILABLE', 'Science interpreter probes require a fully enforced Windows sandbox')
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    services.signal.throwIfAborted()
    const scratch = await createProbeScratch(services.sessionScratch)
    let observationFailure: unknown
    try {
      if (language === 'r' && scratch.tmp.includes(' ')) {
        throw new ScienceRuntimeError('CONFINEMENT_UNAVAILABLE', 'R probe TMPDIR cannot contain an ASCII space')
      }
      const version = await runProbe(services, staticFacts.prefix, scratch, probeArgv(language, staticFacts.executable, 'version'))
      const utf8 = await runProbe(services, staticFacts.prefix, scratch, probeArgv(language, staticFacts.executable, 'utf8'))
      const normalized = version.ok ? normalizeVersion(version.stdout, version.stderr) : undefined
      const after = await staticInterpreter(language, configuredPrefix)
      const stable = after.prefix === staticFacts.prefix
        && after.executable === staticFacts.executable
        && after.identity === staticFacts.identity
        && Buffer.compare(after.history, staticFacts.history) === 0
      if (!stable) {
        if (attempt === 0) {
          staticFacts = after
          continue
        }
        return {
          prefix: after.prefix,
          executable: after.executable,
          binding: { language, configuredPrefix, canonicalPrefix: after.prefix, capability: 'invalid', reason: 'environment changed during observation' },
        }
      }
      if (normalized === undefined || !utf8.ok || utf8.stdout !== UTF8_PROBE_TEXT || utf8.stderr.length !== 0) {
        return {
          prefix: staticFacts.prefix,
          executable: staticFacts.executable,
          binding: { language, configuredPrefix, canonicalPrefix: staticFacts.prefix, executable: staticFacts.executable, capability: 'invalid', reason: 'interpreter probes did not produce the required lossless output' },
        }
      }
      const historySha = sha256(staticFacts.history)
      const fingerprint = sha256(`dsh-science-binding-v1\0${language}\0${staticFacts.prefix}\0${staticFacts.executable}\0${staticFacts.identity}\0${normalized}\0${historySha}`)
      return {
        prefix: staticFacts.prefix,
        executable: staticFacts.executable,
        binding: {
          language,
          configuredPrefix,
          canonicalPrefix: staticFacts.prefix,
          executable: staticFacts.executable,
          executableIdentity: staticFacts.identity,
          languageVersion: normalized,
          condaHistorySha256: historySha,
          bindingFingerprint: fingerprint,
          capability: 'available',
        },
      }
    } catch (error) {
      observationFailure = error
      throw error
    } finally {
      try {
        await removeProbeScratch(services.sessionScratch, scratch)
      } catch (cleanupError) {
        if (observationFailure !== undefined) {
          throw new AggregateError(
            [observationFailure, cleanupError],
            'science-runtime: interpreter observation and probe cleanup both failed',
          )
        }
        throw cleanupError
      }
    }
  }
  throw new Error('science-runtime: stable observation exhausted unexpectedly')
}

/**
 * Observe every configured interpreter without calling Conda or modifying a prefix.
 * @param services - Shared services and exact Session-owned probe scratch.
 * @param profile - Strict profile whose declared interpreters are observed.
 * @returns Settled stable observations after every attempted probe cleanup has settled.
 */
export async function observeProfile(services: ObservationServices, profile: ConfiguredProfile): Promise<ObservedProfile> {
  if (services.subprocess.executionWorld !== 'host-local') {
    throw new ScienceRuntimeError('CONFINEMENT_UNAVAILABLE', 'Science private Host scratch requires a host-local subprocess provider')
  }
  const failures: unknown[] = []
  const observe = (language: ScienceLanguage, prefix: string): Promise<ObservedInterpreter> => {
    return observeStable(services, language, prefix).catch((error: unknown) => {
      failures.push(error)
      throw error
    })
  }
  let python: ObservedInterpreter | undefined
  let r: ObservedInterpreter | undefined
  const observations: Promise<void>[] = []
  if (profile.pythonPrefix !== undefined) {
    observations.push(observe('python', profile.pythonPrefix).then((value) => {
      python = value
    }))
  }
  if (profile.rPrefix !== undefined) {
    observations.push(observe('r', profile.rPrefix).then((value) => {
      r = value
    }))
  }
  const settled = await Promise.allSettled(observations)
  const errors: unknown[] = []
  for (const result of settled) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  if (errors.length > 0) {
    const initiatingFailure = failures[0] ?? errors[0]
    const initiatingError = initiatingFailure instanceof Error
      ? initiatingFailure
      : new Error('science-runtime: interpreter observation failed without an Error object')
    if (errors.length === 1) throw initiatingError
    const remaining = [...errors]
    const initiatingIndex = remaining.indexOf(initiatingFailure)
    if (initiatingIndex >= 0) remaining.splice(initiatingIndex, 1)
    throw new AggregateError(
      [initiatingError, ...remaining],
      'science-runtime: interpreter observations failed after all probe cleanup settled',
    )
  }
  return {
    profile,
    ...(python === undefined ? {} : { python }),
    ...(r === undefined ? {} : { r }),
  }
}

/**
 * Compare two available bindings by their durable observation fingerprint.
 * @param first - First optional durable binding.
 * @param second - Second optional durable binding.
 * @returns Whether both absent bindings or both available fingerprints match.
 */
export function sameObservation(first: ScienceInterpreterBinding | undefined, second: ScienceInterpreterBinding | undefined): boolean {
  if (first === undefined || second === undefined) return first === second
  return first.capability === 'available'
    && second.capability === 'available'
    && first.bindingFingerprint === second.bindingFingerprint
}
