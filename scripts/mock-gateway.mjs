import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
// Development-only local responses. No request ever reaches a model provider.
export async function startMockGateway({ repeat = 1, delay = 30, backgroundDelay = 0, streamFinishes = [], speechHandler = null, asrHandler = null, memoryHandler = null, intentionHandler = null, chatHandler = null, explainHandler = null, genieHandler = null, patternHandler = null, searchHandler = null, routerHandler = null } = {}) {
  const requests = [];
  let streams = 0;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const bytes of request) body += bytes;
    const input = JSON.parse(body); requests.push(input);
    if (input.response_format?.json_schema?.name.startsWith('stomylos_character_scores_v') && routerHandler) { await routerHandler(input, response); return; }
    if (input.stream && input.response_format?.type === 'json_object') {
      if (searchHandler) { await searchHandler(input, response); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ model: input.model, provider: 'Public mock', choices: [{ delta: { content: '{"search":false}' }, finish_reason: 'stop' }], usage: { total_tokens: 50, cost: 0 } })}\n\ndata: [DONE]\n\n`); return;
    }
    if (input.response_format?.json_schema?.name === 'stomylos_memory_delta_v1' && memoryHandler) { await memoryHandler(input, response); return; }
    if (input.response_format?.json_schema?.name === 'genie_expression_v1' && genieHandler) { await genieHandler(input, response); return; }
    if (input.model === 'openai/gpt-6-astra' && !input.stream && input.max_tokens === 32768 && patternHandler) { await patternHandler(input, response); return; }
    if (!input.stream && input.messages?.[0]?.content.startsWith('Generate one English conversation-opening question')) {
      if (intentionHandler) { await intentionHandler(input, response); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: input.model, provider: { openai: 'OpenAI', mistral: 'Mistral', 'deepinfra/turbo': 'DeepInfra' }[input.provider.only[0]],
        choices: [{ finish_reason: 'stop', message: { content: `What would you like to explore about this plan ${requests.length}?` } }], usage: { cost: 0 } })); return;
    }
    if (input.model === 'openai/gpt-5.6-luna' && !input.stream && input.messages?.[0]?.content.startsWith('Restate the possible meanings')) {
      if (explainHandler) { await explainHandler(input, response); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: input.model, provider: 'OpenAI', choices: [{ message: { content: 'You are almost done.' }, finish_reason: 'stop' }], usage: { total_tokens: 50, cost: 0 } })); return;
    }
    if (input.stream && chatHandler) { await chatHandler(input, response); return; }
    if (request.url === '/audio/transcriptions') {
      if (asrHandler) { await asrHandler(input, response); return; }
      response.writeHead(200, { 'content-type': 'application/json', 'x-generation-id': 'public-asr-mock' });
      response.end(JSON.stringify({ text: 'Um, I goes walking. 한국어도 말해요.', usage: { cost: 0 } })); return;
    }
    if (request.url === '/audio/speech') {
      if (speechHandler) { await speechHandler(input, response); return; }
      response.writeHead(200, { 'content-type': 'audio/mpeg', 'x-generation-id': 'public-speech-mock' });
      response.end(await readFile(new URL('../tests/fixtures/speech-tone.mp3', import.meta.url))); return;
    }
    if (input.stream) {
      const finish = streamFinishes[streams++] ?? 'stop';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = 'A quiet walk creates a small pause before the day gathers speed. Familiar places can become more interesting when you have time to notice them. The same tree may look different in changing light, and the birds often make a familiar street sound surprisingly alive. That seems like a useful way to begin without making the morning another task to complete.';
      for (const word of (text + ' ').repeat(repeat).match(/\S+\s*/g)) {
        if (response.destroyed) return;
        response.write(`data: ${JSON.stringify({ model: input.model, provider: 'Public mock', choices: [{ index: 0, delta: { content: word }, finish_reason: null }] })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      const usage = finish === 'length' ? { prompt_tokens: 100, completion_tokens: 8192, total_tokens: 8292,
        completion_tokens_details: { reasoning_tokens: 8000 }, cost: .01 } : { total_tokens: 100 };
      response.end(`data: ${JSON.stringify({ id: `public-stream-${streams}`, model: input.model, provider: 'Public mock', choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`);
    } else {
      let content; let provider = 'OpenAI';
      if (!input.response_format) {
        content = `Which small invention would help on day ${requests.length}?\nWhat would courage sound like at hour ${requests.length}?`;
        provider = { 'google-ai-studio': 'Google AI Studio', 'novita/fp8': 'Novita', anthropic: 'Anthropic' }[input.provider.only[0]];
      } else if (input.response_format.json_schema.name === 'stomylos_memory_delta_v1') { content = '{"operations":[]}'; provider = 'Google AI Studio'; }
      else if (input.response_format.json_schema.name.startsWith('stomylos_character_scores_v')) content = JSON.stringify(Object.fromEntries(input.response_format.json_schema.schema.required.map(id => [id, ['informative_generalist', 'model_03'].includes(id) ? 2 : 1])));
      else if (input.response_format.json_schema.name === 'genie_expression_v1') content = JSON.stringify({ reply: 'This wording keeps your meaning.', suggested_text: 'I enjoy quiet mornings.' });
      else content = JSON.stringify({ units: JSON.parse(input.messages[1].content).filter(m => m.role === 'user').map(m => ({ text: m.content, corrected_text: m.content, explanation: '' })) });
      if (!input.response_format?.json_schema.name.startsWith('stomylos_character_scores_v') && backgroundDelay) await new Promise(resolve => setTimeout(resolve, backgroundDelay));
      if (response.destroyed) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: input.model, provider, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { total_tokens: 100, cost: 0 } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, endpoint: `http://127.0.0.1:${server.address().port}/completion` };
}
