import dotenv from 'dotenv';
import EmbedAPI from '@embedapi/core';

dotenv.config();

async function testApi() {
  const apiKey = process.env.EMBEDAPI_KEY;
  console.log(`API Key: ${apiKey ? '******' : 'undefined/missing'}`);

  const embedApi = new EmbedAPI(apiKey);
  try {
    const response = await embedApi.generate({
      service: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hello!' }],
      maxTokens: 10
    });
    console.log('API call successful:', response.data);
  } catch (error) {
    console.error('API call failed:', error);
  }
}

testApi();
