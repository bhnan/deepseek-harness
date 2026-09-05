/** Resolved deployment configuration for optional browser password login. */

import z from '@deepseek-ai/schemastery'

/** One deployment-managed account for browser password login. */
export interface PasswordLoginConfig {
  /** Shared account name accepted by the password-login form. */
  readonly username: string
  /** Shared password retained only by the Host process. */
  readonly password: string
  /** Absolute password-session lifetime in days. Default: 7; minimum: 7. */
  readonly sessionMaxAgeDays: number
  /** Bounded generic failed-login delay in milliseconds. Default: 500; maximum: 10,000. */
  readonly failureDelayMs: number
  /** Whether password-session cookies carry the Secure attribute. Default: true. */
  readonly secureCookie: boolean
}

/** Schemastery validation and defaults for one configured password-login account. */
export const PasswordLoginConfigSchema: z<PasswordLoginConfig> = z.object({
  username: z.string().min(1).required(),
  password: z.string().min(1).required(),
  sessionMaxAgeDays: z.natural().min(7).default(7),
  failureDelayMs: z.natural().max(10_000).default(500)
    .description('Bounded generic failed-login delay in milliseconds.'),
  secureCookie: z.boolean().default(true),
})
