import type { Context } from '@deepseek-ai/cordis'

/** Client services the browser half waits for. */
export declare const inject: string[]
/**
 * Register the file manager tab, its body, and the two action contributions.
 * @param ctx browser root context.
 */
export declare function apply(ctx: Context): void
