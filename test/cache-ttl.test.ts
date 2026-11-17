// The 1-hour cache setting: every mark a request carries takes Anthropic's 1h TTL, so a lead turn that starts after a long idle reads
// its prefix instead of writing it again (#L1). The default leaves today's payloads as they are, and the compactor keeps 5 minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type Theme } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { createProfile, defaults, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { cachePayload, splitView } from '../src/core/cache.ts';
import { invalid, readSettings, SETTINGS } from '../src/settings.ts';
import { settingsPage } from '../src/settings-page.ts';
import { atWork, textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-cache-agent-'));
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const model = { provider: 'fixture', model: 'fixture', thinking: 'off' } as const;
const fixtureModel = (id: string) => ({ id, name: id, reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 });

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}

/** The view as Anthropic receives it: blocks of 4 lines with marks on the last whole one, 20 and 40 blocks before it; then a task. */
const line = '0+1|summary of a decision\n';
const view = '<chat>\n' + line.repeat(200) + '</chat>';
const viewPieces = splitView(view);
const marksAt = [viewPieces.length - 42, viewPieces.length - 22, viewPieces.length - 2];
const mark = (ttl?: '1h') => ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
/** Pi's own marks on the system prompt, the tools, the message and the task block, as pi-ai adds them and cachePayload drops them. */
const request = () => ({ system: [{ type: 'text', text: 'identity', cache_control: mark() }, { type: 'text', text: 'system', cache_control: mark() }],
  tools: [{ name: 'zoom', cache_control: mark() }],
  messages: [{ role: 'user', content: [{ type: 'text', text: view }, { type: 'text', text: '\n\nYour task:\nFix it.', cache_control: mark() }] }] });
const marks = (output: unknown) => JSON.stringify(output).match(/"cache_control":\{"type":"ephemeral"(?:,"ttl":"1h")?\}/g) ?? [];
type Request = ReturnType<typeof request>;

test('the default leaves the payload byte for byte as it was: bare ephemeral marks, no ttl', () => {
  const expected = { system: [{ type: 'text', text: 'identity' }, { type: 'text', text: 'system' }], tools: [{ name: 'zoom' }],
    messages: [{ role: 'user', content: [...viewPieces.map((text, j) => ({ type: 'text', text, ...(marksAt.includes(j) ? { cache_control: mark() } : {}) })),
      { type: 'text', text: '\n\nYour task:\nFix it.', cache_control: mark() }] }] };
  const output = cachePayload(request());
  assert.deepEqual(output, expected);
  assert.equal(JSON.stringify(output), JSON.stringify(expected), 'byte for byte');
  assert.ok(!JSON.stringify(output).includes('ttl'), '5 minutes is a bare ephemeral mark');
});

test('the 1-hour cache marks every mark 1h, with none left at 5 minutes', () => {
  const output = cachePayload(request(), { ttl: '1h' }) as Request & { cache_control?: unknown };
  assert.equal(marks(output).length, 4, "three view marks and the end mark: Anthropic's limit");
  for (const found of marks(output)) assert.equal(found, '"cache_control":{"type":"ephemeral","ttl":"1h"}', 'no mark lacks the ttl');
  assert.equal(output.cache_control, undefined, 'still no top-level automatic mark');
  assert.deepEqual(output.messages[0].content.slice(0, -1).filter(block => 'cache_control' in block).map(block => block.cache_control), 
    [mark('1h'), mark('1h'), mark('1h')], "the view's three marks");
  assert.deepEqual(output.messages[0].content.at(-1), { type: 'text', text: '\n\nYour task:\nFix it.', cache_control: mark('1h') }, 'the end mark');
  assert.equal(output.messages[0].content.map(block => block.text).join(''), view + '\n\nYour task:\nFix it.', 'the text is unchanged apart from the split');
});

test("the turn's mark before the status line takes the 1h TTL too", () => {
  const status = atWork([{ id: 'a1', task: 'Fix it' }])!;
  const payload = { messages: [
    { role: 'user', content: [{ type: 'text', text: view }, { type: 'text', text: 'question' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: status }] },
    { role: 'system', content: [], output_config: { effort: 'low' } },
  ] };
  const output = cachePayload(payload, { ttl: '1h' }) as typeof payload;
  assert.equal(marks(output).length, 4, 'three view marks and the turn');
  for (const found of marks(output)) assert.equal(found, '"cache_control":{"type":"ephemeral","ttl":"1h"}');
  assert.deepEqual(output.messages[2].content[0], { type: 'tool_result', tool_use_id: 't', content: 'ok', cache_control: mark('1h') },
    'the turn mark sits on the block before the status line');
  assert.ok(!('cache_control' in output.messages[3].content[0]), 'and never on the status line');
});

test("the compactor's marks stay at 5 minutes", () => {
  const output = cachePayload(request(), { end: false });
  assert.equal(marks(output).length, 3, 'the view marks only: no end mark');
  assert.ok(!JSON.stringify(output).includes('ttl'), 'no 1h mark even when the main requests take one');
});

test('the 1-hour cache is off by default, so existing configs and the recipe keep 5 minutes', () => {
  assert.equal(SETTINGS.cacheTtl.kind, 'toggle');
  assert.equal(SETTINGS.cacheTtl.default, false);
  assert.equal(readSettings({}).cacheTtl, false, 'a config.json written before the setting existed');
  assert.equal(readSettings({ cacheTtl: true }).cacheTtl, true);
  assert.match(invalid('cacheTtl', 1)!, /1-hour cache must be true or false/);
  assert.throws(() => readSettings({ cacheTtl: 'yes' }), /1-hour cache must be true or false/);
});

test('the settings page lists the 1-hour cache and saves it on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-cache-page-'));
  try {
    const config = { ...defaults };
    const page = settingsPage(plain, { profile: 'demo', config, models: [{ name: 'anthropic/claude-sonnet-5-5', thinking: ['low', 'medium'] }], dir }, () => {});
    assert.match(page.render(120).join('\n'), /1-hour cache\s+off  default\n/);
    // Down past the two model rows and the ten settings above it, then toggle it.
    for (let i = 0; i < 12; i++) page.handleInput('\x1b[B');
    page.handleInput(' ');
    assert.equal(config.cacheTtl, true);
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).cacheTtl, true);
    assert.match(page.render(120).join('\n'), /1-hour cache\s+on  default off/);
    page.handleInput('\x1b');
  } finally { removeDir(dir); }
});

/** The main agent's own request handler, as index.ts registers it: the profile's setting read per request. */
async function mainMarks(cacheTtl?: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-cache-main-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'anthropic-messages', models: [fixtureModel('fixture')],
      streamSimple: () => { throw new Error('no request goes out'); } });
    createProfile('fixture');
    const config = { ...loadConfig(profilePath('fixture')), compactor: model };
    saveConfig(profilePath('fixture'), cacheTtl === undefined ? config : { ...config, cacheTtl });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] })).session;
    await session.bindExtensions({});
    return await session.extensionRunner.emitBeforeProviderRequest(request()) as Request;
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
}

test("the main agent's request takes the 1-hour cache when the profile says so, and 5 minutes otherwise", async () => {
  const off = await mainMarks();
  assert.equal(marks(off).length, 4, 'the view and the end are marked');
  for (const found of marks(off)) assert.equal(found, '"cache_control":{"type":"ephemeral"}', 'the default profile writes 5-minute marks');
  const on = await mainMarks(true);
  assert.equal(marks(on).length, 4);
  for (const found of marks(on)) assert.equal(found, '"cache_control":{"type":"ephemeral","ttl":"1h"}', 'the 1-hour profile writes 1h marks');
});

/** A child's first request, through the handler agents.ts registers on its session. */
async function childMarks(cacheTtl: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-cache-child-'));
  const seen: { payload: unknown; text: string }[] = [];
  try {
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'anthropic-messages', models: [fixtureModel('child')],
      streamSimple: (m, context, options) => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: m.api, provider: m.provider, model: m.id,
          timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
        const text = textContent(context.messages.find(x => x.role === 'user')?.content);
        void (async () => {
          // The payload pi-ai builds for Anthropic, with the view in the first message; the session's own payload hook transforms it.
          const payload = { system: [{ type: 'text', text: 'system', cache_control: mark() }], tools: [{ name: 'zoom', cache_control: mark() }],
            messages: [{ role: 'user', content: [{ type: 'text', text, cache_control: mark() }] }] };
          seen.push({ payload: await options?.onPayload?.(payload, m), text });
          stream.push({ type: 'done', reason: 'stop', message }); stream.end();
        })();
        return stream;
      } });
    const memory = new Memory(join(dir, 'memory'), async input => input.source.slice(0, 100), () => {});
    for (let i = 0; i < 200; i++) memory.append('user', `message ${i} of the view`);
    const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'fixture', model: 'child', thinking: 'off' }), () => '',
      async () => {}, () => {}, join(dir, 'memory'), { settings: () => ({ cacheTtl }), createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
    try {
      await children.spawn([{ task: 'report back' }], dir);
      await until(() => !children.active && seen.length > 0);
    } finally { await children.close(); await memory.close(); }
    return seen[0];
  } finally { removeDir(dir); }
}

test("a subagent's first request takes the profile's 1-hour cache on every mark, the view's and the task's", async () => {
  const off = await childMarks(false);
  assert.ok(off.text.includes('<chat>') && off.text.includes('Your task:'));
  assert.equal(marks(off.payload).length, 4, 'three view marks and the task');
  for (const found of marks(off.payload)) assert.equal(found, '"cache_control":{"type":"ephemeral"}', 'the default profile writes 5-minute marks');
  const on = await childMarks(true);
  assert.equal(marks(on.payload).length, 4);
  for (const found of marks(on.payload)) assert.equal(found, '"cache_control":{"type":"ephemeral","ttl":"1h"}', 'no mark lacks the ttl');
});
