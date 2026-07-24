import EmbedAPI from '@embedapi/core';

export default async function callEmbedApi(prompt, apiKey) {
  const embedApi = new EmbedAPI(apiKey);
  try {
    const response = await embedApi.generate({
      service: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 2048,
      timeout: 120000, // 120 seconds
    });
    return response.data;
  } catch (error) {
    console.error('Error calling EmbedAPI SDK:', error);
    // Let the worker handle the timeout error
    throw error;
  }
}
