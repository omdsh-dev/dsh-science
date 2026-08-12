/**
 * Science Session Domain: typed durable facts, strict replay validation, and
 * the optional `science` session projection. This Phase 1 package exposes no
 * mutation service and performs no environment or process work.
 *
 * @module @deepseek-ai/dsh-science-session
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import { SCIENCE_PROJECTION_STATE_VERSION } from './ids.ts'
import { applyScienceProjection, scienceProjectionSchema } from './projection.ts'
import type { ScienceProjection } from './types.ts'

export * from './types.ts'
export * from './domain.ts'
export * from './fold.ts'
export * from './projection.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'science-session'

/** No hard service dependency; projection composition is optional. */
export const inject: readonly string[] = []

/** Register the Science projection only when the host composes its registry. */
export function apply(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'science', ScienceProjection | null>({
      key: 'science',
      schema: scienceProjectionSchema,
      init: () => null,
      apply: applyScienceProjection,
      view: state => state,
      stateVersion: SCIENCE_PROJECTION_STATE_VERSION,
    })
  })
}
