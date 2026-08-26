/** Package-owned invariant companion for experimental basic Web authentication. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-auth-basic'

/** Cordis companion plugin name. */
export const name = 'experimental-auth-basic-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/**
 * No runtime invariant: this adapter owns raw Node listener replacement, but
 * the authoritative listener list is not an event or mutable product datum.
 * The package's real-composition test instead proves disposal restores the
 * original public HTTP behavior.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant ownership.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
