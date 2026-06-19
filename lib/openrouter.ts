import OpenAI from "openai";
import { config } from "./config";

/**
 * Shared OpenRouter client, constructed lazily so importing this module
 * never requires the API key — a missing key fails only at call time, with
 * the clear error from config (mirrors lib/config.ts). Lives on the Node.js
 * runtime resolution path.
 */
let client: OpenAI | undefined;

export function getOpenRouter(): OpenAI {
  if (!client) {
    client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: config.openrouterApiKey,
    });
  }
  return client;
}
