import { config } from "./config";

/**
 * Console logging gated on dev mode (config.devMode). Used to surface which
 * model each generation/moderation call is running — see the prompts in
 * lib/generate.ts and lib/moderate.ts. No-op in production.
 */
export function devLog(...args: unknown[]): void {
  if (config.devMode) {
    console.log("[noumenon]", ...args);
  }
}
