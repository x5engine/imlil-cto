/**
 * Multi-provider API client for imlil.
 * Supports: embedapi | openrouter | custom (OpenAI-compatible, e.g. DeepSeek B300)
 *
 * Provider is selected via IMLIL_PROVIDER env var.
 *
 * Key feature: Structured output via response_format / tools API —
 * the model returns valid JSON natively, no regex needed.
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

const DEFAULT_MODELS = {
  embedapi: 'claude-3-5-sonnet-20241022',
  openrouter: 'openai/gpt-4o',
  custom: 'deepseek-v4-flash',
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
      apiUrl = null;
      model = process.env.IMLIL_MODEL || process.env.EMBEDAPI_MODEL || DEFAULT_MODELS.embedapi;
      break;
  }

  return { provider, apiKey, apiUrl, model };
}

/**
 * Make an HTTP(S) request to any OpenAI-compatible API.
 */
function makeRequest(apiUrl, apiKey, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiUrl);
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
      timeout: 300000,
    };

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
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API request timed out')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Call the API with structured output (response_format=json_object).
 * Guarantees valid JSON from models that support it.
 */
export async function callStructured(prompt, { apiKey, maxTokens = 4096 } = {}) {
  const config = getConfig();
  const resolvedKey = apiKey || config.apiKey;
  if (!resolvedKey) throw new Error(`No API key for provider "${config.provider}"`);

  switch (config.provider) {
    case 'openrouter':
    case 'custom': {
      const body = {
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      };
      const response = await makeRequest(config.apiUrl, resolvedKey, body);
      const content = response?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response from API');
      return JSON.parse(content);
    }

    case 'embedapi': {
      const { default: EmbedAPI } = await import('@embedapi/core');
      const embed = new EmbedAPI(resolvedKey);
      const resp = await embed.generate({
        service: 'anthropic',
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        timeout: 120000,
      });
      return resp.data;
    }
  }
}

/**
 * Call the API with tool/function calling.
 * Returns the tool_calls array from the response.
 */
export async function callWithTools(messages, tools, { apiKey, maxTokens = 4096 } = {}) {
  const config = getConfig();
  const resolvedKey = apiKey || config.apiKey;
  if (!resolvedKey) throw new Error(`No API key for provider "${config.provider}"`);

  switch (config.provider) {
    case 'openrouter':
    case 'custom': {
      const body = {
        model: config.model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: maxTokens,
        temperature: 0.2,
      };
      const response = await makeRequest(config.apiUrl, resolvedKey, body);
      const msg = response?.choices?.[0]?.message;
      return {
        content: msg?.content || '',
        toolCalls: msg?.tool_calls || [],
      };
    }

    case 'embedapi':
    default: {
      // EmbedAPI doesn't support tools — fall back to structured output
      const lastMsg = messages[messages.length - 1];
      const json = await callStructured(lastMsg.content, { apiKey, maxTokens });
      // Wrap in tool call format
      return {
        content: '',
        toolCalls: [{
          type: 'function',
          function: {
            name: json.action || 'writeFile',
            arguments: JSON.stringify(json),
          },
        }],
      };
    }
  }
}

/**
 * Simple text completion (no structured output).
 */
export default async function callProvider(prompt, { apiKey, maxTokens = 4096 } = {}) {
  const config = getConfig();
  const resolvedKey = apiKey || config.apiKey;
  if (!resolvedKey) throw new Error(`No API key for provider "${config.provider}"`);

  switch (config.provider) {
    case 'openrouter':
    case 'custom': {
      const body = {
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.7,
      };
      const response = await makeRequest(config.apiUrl, resolvedKey, body);
      return response?.choices?.[0]?.message?.content || '';
    }

    case 'embedapi':
    default: {
      const { default: EmbedAPI } = await import('@embedapi/core');
      const embed = new EmbedAPI(resolvedKey);
      const resp = await embed.generate({
        service: 'anthropic',
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens,
        timeout: 120000,
      });
      return resp.data;
    }
  }
}

export function getProviderInfo() {
  const config = getConfig();
  return `${config.provider} / ${config.model}`;
}