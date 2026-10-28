import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name. */
export declare const name: string
/** Services the host half waits for. */
export declare const inject: string[]
/** Route namespace served on the web server. */
export declare const ROUTE_PREFIX: string
/** Composition-time defaults for the safety ceilings. */
export declare const DEFAULTS: {
  readonly maxUploadBytes: number
  readonly maxListEntries: number
  readonly zipMaxEntries: number
  readonly zipMaxBytes: number
}
/** Cordis configuration schema (schemastery). */
export declare const Config: unknown
/**
 * Register every route on the web server.
 * @param ctx host context carrying `webServer` (and usually `connection`, `sessions`, `sandboxPolicy`).
 * @param config validated configuration.
 */
export declare function apply(ctx: Context, config?: Partial<typeof DEFAULTS>): void
