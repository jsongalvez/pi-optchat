import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { removeDir } from './support.ts';

// An extension that continues the run from agent_before_settle commits its entries without message_end. OptChat must still
// send them: before, the follow-up request carried nothing new, and Anthropic's message threads answered 400
// "messages must contain at least one 'user' or 'assistant' message".
test('a message committed at the settle boundary reaches the next request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-settle-'));
  process.env.OPTCHAT_HOME = dir;
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `answer ${bodies.length}` } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
      send('message_stop', {});
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  let session: any;
  try {
    createProfile('fixture');
    saveConfig(profilePath('fixture'), { ...loadConfig(profilePath('fixture')), compactor: { provider: 'claudefix', model: 'claude-x', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('claudefix', { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, apiKey: 'x', api: 'anthropic-messages',
      models: [{ id: 'claude-x', name: 'C', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
    let fired = 0;
    const gate = (pi: any) => pi.on('agent_before_settle', (event: any) => fired++ ? undefined
      : { entries: [...event.entries, { type: 'custom_message', customType: 'settle-gate', content: 'Settle gate: do TASK-007', display: true }], continue: true });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat, gate] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('claudefix', 'claude-x'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: [] })).session;
    const errors: string[] = [];
    await session.bindExtensions({ onError: (e: any) => errors.push(e.error) });
    await session.prompt('hello');
    const main = bodies.filter(b => JSON.stringify(b).includes('hello'));
    assert.equal(main.length, 2, 'the gate continued the run once');
    const last = main[1].messages, tail = last.at(-1);
    assert.equal(last.at(-2)?.role, 'assistant');
    assert.equal(tail.role, 'user');
    assert.match(JSON.stringify(tail.content), /\[settle-gate\] Settle gate: do TASK-007/);
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    server.close();
    removeDir(dir);
  }
});
