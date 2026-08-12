/** Owner-aware registration arbitration, including real HMR overlap states. */

import { FiberState } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ErasedDefinition } from '../src/definition.ts'
import { addRegistration, removeRegistration } from '../src/registration.ts'
import type { Registration } from '../src/registration.ts'

const owner = (state: FiberState): Fiber => ({ state }) as Fiber
const firstDefinitionToken = Symbol('first test projection definition')
const secondDefinitionToken = Symbol('second test projection definition')
const definition = (
  stateVersion: number,
  marker: string,
  definitionToken = firstDefinitionToken,
): ErasedDefinition => ({
  key: 'test/key',
  definitionToken,
  schema: { parse: value => value },
  init: () => marker,
  apply: state => state,
  view: state => state,
  stateVersion,
})

describe('projection registration arbitration', () => {
  it('rejects different versions while an existing owner is active', () => {
    const registrations = new Map<string, Registration>()
    addRegistration(registrations, definition(1, 'old'), owner(FiberState.ACTIVE))

    expect(() => addRegistration(
      registrations,
      definition(2, 'new'),
      owner(FiberState.ACTIVE),
    )).toThrow(/already has an active owner/)
  })

  it('lets a new HMR owner take over an unloading definition and rebuilds cells', () => {
    const registrations = new Map<string, Registration>()
    const oldOwner = owner(FiberState.UNLOADING)
    addRegistration(registrations, definition(1, 'old'), oldOwner)
    const before = registrations.get('test/key')!.cells

    const replacement = addRegistration(
      registrations,
      definition(2, 'new', secondDefinitionToken),
      owner(FiberState.ACTIVE),
    )

    expect(registrations.get('test/key')!.active).toBe(replacement)
    expect(registrations.get('test/key')!.cells).not.toBe(before)
  })

  it('rebuilds cells when same-version HMR changes the definition token', () => {
    const registrations = new Map<string, Registration>()
    addRegistration(
      registrations,
      definition(1, 'old'),
      owner(FiberState.UNLOADING),
    )
    const before = registrations.get('test/key')!.cells

    addRegistration(
      registrations,
      definition(1, 'new', secondDefinitionToken),
      owner(FiberState.ACTIVE),
    )

    expect(registrations.get('test/key')!.cells).not.toBe(before)
  })

  it('retains cells when an unloading definition remounts with the same token and version', () => {
    const registrations = new Map<string, Registration>()
    addRegistration(
      registrations,
      definition(1, 'canonical'),
      owner(FiberState.UNLOADING),
    )
    const before = registrations.get('test/key')!.cells

    const replacement = addRegistration(
      registrations,
      definition(1, 'canonical remount'),
      owner(FiberState.ACTIVE),
    )

    expect(registrations.get('test/key')!.active).toBe(replacement)
    expect(registrations.get('test/key')!.cells).toBe(before)
  })

  it('keeps the first same-token definition canonical and falls back without replacing cells', () => {
    const registrations = new Map<string, Registration>()
    const first = addRegistration(
      registrations,
      definition(1, 'first'),
      owner(FiberState.ACTIVE),
    )
    const cells = registrations.get('test/key')!.cells
    const second = addRegistration(
      registrations,
      definition(1, 'second'),
      owner(FiberState.ACTIVE),
    )

    expect(registrations.get('test/key')!.active).toBe(first)
    expect(registrations.get('test/key')!.cells).toBe(cells)

    removeRegistration(registrations, 'test/key', first)
    expect(registrations.get('test/key')!.active).toBe(second)
    expect(registrations.get('test/key')!.cells).toBe(cells)
  })

  it('rejects an active same-version owner with a different definition token', () => {
    const registrations = new Map<string, Registration>()
    addRegistration(registrations, definition(1, 'first'), owner(FiberState.ACTIVE))

    expect(() => addRegistration(
      registrations,
      definition(1, 'second', secondDefinitionToken),
      owner(FiberState.ACTIVE),
    )).toThrow(/only the same definitionToken and stateVersion/)
  })

  it('never falls back to a stale unloading owner when its replacement disposes first', () => {
    const registrations = new Map<string, Registration>()
    const oldOwner = owner(FiberState.UNLOADING)
    const old = addRegistration(registrations, definition(1, 'old'), oldOwner)
    const replacement = addRegistration(
      registrations,
      definition(2, 'new', secondDefinitionToken),
      owner(FiberState.ACTIVE),
    )

    removeRegistration(registrations, 'test/key', replacement)
    expect(registrations.has('test/key')).toBe(false)

    // The delayed disposer of the old HMR fiber is harmless after the key is
    // no longer published.
    removeRegistration(registrations, 'test/key', old)
    expect(registrations.has('test/key')).toBe(false)
  })

  it('ignores disposal of a non-active shared owner', () => {
    const registrations = new Map<string, Registration>()
    const first = addRegistration(
      registrations,
      definition(1, 'first'),
      owner(FiberState.ACTIVE),
    )
    const second = addRegistration(
      registrations,
      definition(1, 'second'),
      owner(FiberState.ACTIVE),
    )

    removeRegistration(registrations, 'test/key', second)
    expect(registrations.get('test/key')!.active).toBe(first)
  })
})
