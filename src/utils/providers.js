/**
 * Multi-provider API client for imlil.
 * Supports: embedapi | openrouter | custom (OpenAI-compatible, e.g. DeepSeek B300)
 *
 * Provider is selected via IMLIL_PROVIDER env var.
 * Each provider has its own env var for the API key.
 *
 * Providers:
 *   embedapi  -> IMLIL_API_KEY (original EmbedAPI key)
 *   openrouter -> OPENROUTER_API_KEY + OPENROUTER_MODEL (default: openai/gpt-4o)
 *   custom     -> CUSTOM_API_KEY + CUSTOM_API_URL + CUSTOM_MODEL (for OpenAI-compatible endpoints)
 *
 * Also supports IMLIL_API_BASE_URL and IMLIL_MODEL as overrides for any provider.
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

// Default models per provider
const DEFAULT_MODELS = {
  embedapi: 'claude-3-5-sonnet-20241022',
  openrouter: 'openai/gpt-4o',
  custom: 'deepseek-chat',
};

function getConfig() {
  const provider = (process.env.IMLIL_PROVIDER || 'embedapi').toLowerCase();

  let apiKey, apiUrl, model;

  switch (provider) {
    case 'openrouter':
      apiKey = process.env.OPENROUTER_API_KEY;
      apiUrl = process.env.IMLIL_API_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions';
      model = process.env.IMLIL_MODEL || process.env.OPENROUTER_MODEL || DEFAULT_MODELS.openrouter;
      break;
    case 'custom':
      apiKey = process.env.CUSTOM_API_KEY;
      apiUrl = process.env.IMLIL_API_BASE_URL || process.env.CUSTOM_API_URL || 'http://localhost:8000/v1/chat/completions';
      model = process.env.IMLIL_MODEL || process.env.CUSTOM_MODEL || DEFAULT_MODELS.custom;
      break;
    case 'embedapi':
    default:
      apiKey = process.env.IMLIL_API_KEY;
      apiUrl = null; // embedapi uses its own SDK
      model = process.env.IMLIL_MODEL || process.env.EMBEDAPI_MODEL || DEFAULT_MODELS.embedapi;
      break;
  }

  return { provider, apiKey, apiUrl, model };
}

/**
 * Check if a string looks like a streaming SSE response and return only the
 * data payloads concatenated.
 */
function extractStreamData(raw) {
  const lines = raw.split('\n');
  const payloads = [];
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content || '';
        if (content) payloads.push(content);
      } catch {
        // not JSON, skip
      }
    }
  }
  return payloads.join('');
}

/**
 * Call any OpenAI-compatible API via HTTP(S).
 * Returns the full response text.
 */
function callOpenAICompatible(apiUrl, apiKey, messages, model, maxTokens = 4096) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiUrl);
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: false,
    });

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 120000, // 120s
    };

    // OpenRouter needs extra headers
    if (options.hostname.includes('openrouter')) {
      options.headers['HTTP-Referer'] = 'https://imlil.dev';
      options.headers['X-Title'] = 'imlil-cto';
    }

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`API error ${res.statusCode}: ${data.slice(0, 500)}`));
          return;
        }

        try {
          const parsed = JSON.parse(data);
          // Check for streaming response that wasn't streamed
          if (parsed.choices?.[0]?.message?.content) {
            resolve(parsed.choices[0].message.content);
          } else if (parsed.choices?.[0]?.delta?.content) {
            resolve(parsed.choices[0].delta.content);
          } else if (parsed.data) {
            // embedapi-style response
            resolve(parsed.data);
          } else {
            reject(new Error(`Unexpected API response format: ${JSON.stringify(parsed).slice(0, 200)}`));
          }
        } catch (e) {
          // Maybe it's a streaming response that didn't parse cleanly
          const extracted = extractStreamData(data);
          if (extracted) {
            resolve(extracted);
          } else {
            reject(new Error(`Failed to parse API response: ${e.message}\nResponse: ${data.slice(0, 500)}`));
          }
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('API request timed out after 120s'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Main entry point: call any provider.
 * @param {string} prompt - The text prompt to send
 * @param {object} options
 * @param {string} [options.apiKey] - Override API key
 * @param {number} [options.maxTokens=4096] - Max tokens in response
 * @returns {Promise<string>} The response text
 */
export default async function callProvider(prompt, { apiKey, maxTokens = 4096 } = {}) {
  const config = getConfig();

  // Use provided key or fall back to env-determined one
  const resolvedKey = apiKey || config.apiKey;

  if (!resolvedKey) {
    throw new Error(
      `No API key found for provider "${config.provider}". ` +
      `Set IMLIL_PROVIDER env var (embedapi|openrouter|custom) and the corresponding API key.`
    );
  }

  const messages = [{ role: 'user', content: prompt }];

  switch (config.provider) {
    case 'openrouter':
    case 'custom':
      return callOpenAICompatible(config.apiUrl, resolvedKey, messages, config.model, maxTokens);

    case 'embedapi':
    default: {
      // Use the original EmbedAPI SDK
      const { default: EmbedAPI } = await import('@embedapi/core');
      const embedApi = new EmbedAPI(resolvedKey);
      const response = await embedApi.generate({
        service: 'anthropic',
        model: config.model,
        messages,
        maxTokens,
        timeout: 120000,
      });
      return response.data;
    }
  }
}

/**
 * Get a human-readable description of the current provider config.
 */
export function getProviderInfo() {
  const config = getConfig();
  return `${config.provider} / ${config.model}`;
}