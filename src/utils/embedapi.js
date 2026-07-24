/**
 * Legacy wrapper — delegates to the multi-provider system.
 * Maintains the same callEmbedApi(prompt, apiKey) signature
 * so existing code works without changes.
 */
import callProvider from './providers.js';

export default async function callEmbedApi(prompt, apiKey) {
  return callProvider(prompt, { apiKey, maxTokens: 4096 });
}