import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { profileRules, type PromptBlock } from '../src/profiles.ts';
import { readRun } from '../src/run-record.ts';
import type { Settings } from '../src/settings.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-context-'));

// A line only the project's own AGENTS.md holds: a child that read it, read the context files.
const PROJECT_MARKER = 'PROJECT-MARKER this repository translates one novel per language';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}
const model = (id: string) => ({ id, name: id, reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 });
type Request = { task: string; system: string; tools: string[]; payload: string };

/** A project directory holding an AGENTS.md, so pi's loader has one context file to find or to keep out. */
function project(dir: string) {
  const path = join(dir, 'project');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'AGENTS.md'), `# Project rules\n\n${PROJECT_MARKER}\n`);
  return path;
}

async function setup(dir: string, hold = new Set<string>(), settings: () => Partial<Settings> = () => ({}),
  rules: (loaded: string[]) => string | PromptBlock[] = () => 'USER INSTRUCTIONS') {
  const requests: Request[] = [], releases: (() => void)[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions', models: [model('child')],
    streamSimple: (model, context: Context, options) => {
      const first = textContent(context.messages.find(m => m.role === 'user')?.content);
      const task = first.split('Your task:\n').at(-1) ?? '';
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, model: model.id, provider: model.provider, stopReason: 'stop', timestamp: Date.now(), usage: emptyUsage() };
      void (async () => {
        await options?.onPayload?.({ messages: [] }, model);
        const messages = context.messages as unknown as { role: string; content?: unknown; sections?: Record<string, string>; toolsAdded?: { name: string }[] }[];
        requests.push({ task, system: messages.filter(m => m.role === 'system').map(m => [textContent(m.content as never), ...Object.values(m.sections ?? {})].join('\n')).join('\n'),
          tools: messages.flatMap(m => (m.toolsAdded ?? []).map(t => t.name)), payload: JSON.stringify(context) });
        if (hold.delete(task)) await new Promise<void>(resolve => { releases.push(resolve); });
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'done', partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      })();
      return stream;
    },
  });
  const memory = new Memory(join(dir, 'profile'), async input => input.source.slice(0, 100), () => {});
  const make = () => new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'off' }), rules, async () => {}, () => {},
    join(dir, 'profile'), { settings: () => ({ subagentLevels: 2, maxAgents: 8, ...settings() }), createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  return { requests, release: () => { for (const r of releases.splice(0)) r(); }, make };
}
const record = (children: Children, id: string) => children.history.records.get(id);

test("context 'none': the child loads no context files, the plain child loads the project's AGENTS.md", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-context-none-'));
  const { requests, make } = await setup(dir);
  const children = make(), cwd = project(dir);
  try {
    const [plain, blind] = await children.spawn([{ task: 'spawn-plain', cwd }, { task: 'spawn-blind', cwd, context: 'none' }], cwd);
    await until(() => !children.active);
    const sighted = requests.find(r => r.task === 'spawn-plain')!, dark = requests.find(r => r.task === 'spawn-blind')!;
    assert.ok(sighted.system.includes(PROJECT_MARKER), 'a child with no context choice reads its project AGENTS.md');
    assert.ok(!dark.system.includes(PROJECT_MARKER) && !dark.payload.includes(PROJECT_MARKER), "context: 'none' keeps every context file out");
    assert.ok(sighted.system.includes('USER INSTRUCTIONS') && !dark.system.includes('USER INSTRUCTIONS'), 'the profile rules reach only the sighted child');
    assert.deepEqual([record(children, blind)?.context, record(children, blind)?.contextFrom], ['none', 'task'], 'the record says the task did it');
    assert.deepEqual([record(children, plain)?.context, record(children, plain)?.contextFrom], ['files', 'default']);
    assert.deepEqual([readRun(join(dir, 'profile'), blind).context, readRun(join(dir, 'profile'), blind).contextFrom], ['none', 'task'], 'saved with the run');
  } finally { await children.close(); removeDir(dir); }
});

test("a resumed 'none' child reopens without the context files, after a reload too", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-context-resume-'));
  const { requests, make } = await setup(dir);
  const children = make(), cwd = project(dir);
  try {
    const [blind] = await children.spawn([{ task: 'spawn-blind', cwd, context: 'none' }], cwd);
    await until(() => !children.active);
    await children.tell(blind, 'one more passage');
    await until(() => !children.active && record(children, blind)?.state === 'completed');
    await children.close();
    const reloaded = make(); // as /reload does: a new process reads the saved record
    assert.equal(record(reloaded, blind)?.context, 'none');
    await reloaded.tell(blind, 'and another');
    await until(() => !reloaded.active && record(reloaded, blind)?.state === 'completed');
    const dark = requests.filter(r => r.task === 'spawn-blind');
    assert.equal(dark.length, 3, 'spawned, resumed, resumed after reload');
    for (const r of dark) assert.ok(!r.payload.includes(PROJECT_MARKER) && !r.system.includes(PROJECT_MARKER), 'no context file comes back on a resume');
    await reloaded.close();
  } finally { await children.close(); removeDir(dir); }
});

test("memory 'none' alone still loads the context files: the two switches are separate", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-context-vs-memory-'));
  const { requests, make } = await setup(dir);
  const children = make(), cwd = project(dir);
  try {
    const [memoryNone] = await children.spawn([{ task: 'memory-none', cwd, memory: 'none' }], cwd);
    const [both] = await children.spawn([{ task: 'both-none', cwd, memory: 'none', context: 'none' }], cwd);
    await until(() => !children.active);
    assert.ok(requests.find(r => r.task === 'memory-none')!.system.includes(PROJECT_MARKER), "memory: 'none' alone keeps the context files");
    assert.ok(!requests.find(r => r.task === 'both-none')!.system.includes(PROJECT_MARKER));
    assert.deepEqual([record(children, memoryNone)?.context, record(children, memoryNone)?.contextFrom], ['files', 'default']);
    assert.deepEqual([record(children, both)?.context, record(children, both)?.contextFrom], ['none', 'task']);
  } finally { await children.close(); removeDir(dir); }
});

test("a blind parent's children stay without the context files, whatever their task asks for", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-context-inherited-'));
  const { requests, release, make } = await setup(dir, new Set(['blind parent']));
  const children = make(), cwd = project(dir);
  try {
    const [parent] = await children.spawn([{ task: 'blind parent', cwd, context: 'none' }], cwd);
    await until(() => requests.some(r => r.task === 'blind parent'));
    const [child] = await children.spawn([{ task: 'asks for the files', cwd, context: 'files' }], cwd, undefined, parent);
    await until(() => record(children, child)?.state === 'completed');
    assert.ok(!requests.find(r => r.task === 'asks for the files')!.system.includes(PROJECT_MARKER), 'a blind parent wins over the task');
    assert.deepEqual([record(children, child)?.context, record(children, child)?.contextFrom], ['none', 'inherited']);
    release();
    await until(() => !children.active);
  } finally { release(); await children.close(); removeDir(dir); }
});

// The spawn contract for the profile's rules: what the lead reads (the profile's AGENTS.md and its project repo's), every
// subagent reads too, once, and a blind one reads none of it.
const PROFILE_MARKER = 'PROFILE-MARKER research on Opus, grunt work on the default';
const count = (text: string, marker: string) => text.split(marker).length - 1;
async function profileSetup(dir: string) {
  const profileDir = join(dir, 'profile'), repo = join(dir, 'literary-mt'), tries = join(dir, 'tries');
  for (const path of [profileDir, repo, tries]) mkdirSync(path, { recursive: true });
  writeFileSync(join(profileDir, 'AGENTS.md'), `# Profile\n\n${PROFILE_MARKER}\n`);
  writeFileSync(join(repo, 'AGENTS.md'), `# Project rules\n\n${PROJECT_MARKER}\n`);
  return { repo, tries, ...await setup(dir, undefined, undefined, loaded => profileRules(profileDir, repo, loaded)) };
}

test('a subagent outside the project repo reads the profile AGENTS.md and the project AGENTS.md, once each', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-rules-tries-'));
  const { tries, requests, make } = await profileSetup(dir);
  const children = make();
  try {
    await children.spawn([{ task: 'in-tries', cwd: tries }], tries);
    await until(() => !children.active);
    const { system } = requests.find(r => r.task === 'in-tries')!;
    assert.deepEqual([count(system, PROFILE_MARKER), count(system, PROJECT_MARKER)], [1, 1]);
  } finally { await children.close(); removeDir(dir); }
});

test('a subagent in the project repo reads its AGENTS.md exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-rules-repo-'));
  const { repo, requests, make } = await profileSetup(dir);
  const children = make();
  try {
    await children.spawn([{ task: 'in-repo', cwd: repo }], repo);
    await until(() => !children.active);
    const { system } = requests.find(r => r.task === 'in-repo')!;
    assert.deepEqual([count(system, PROFILE_MARKER), count(system, PROJECT_MARKER)], [1, 1], 'the context file, not a second copy from the profile rules');
  } finally { await children.close(); removeDir(dir); }
});

test("context 'none' gets neither the profile's AGENTS.md nor its project's", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-rules-blind-'));
  const { tries, repo, requests, make } = await profileSetup(dir);
  const children = make();
  try {
    await children.spawn([{ task: 'blind-tries', cwd: tries, context: 'none' }, { task: 'blind-repo', cwd: repo, context: 'none' }], tries);
    await until(() => !children.active);
    for (const task of ['blind-tries', 'blind-repo']) {
      const { system, payload } = requests.find(r => r.task === task)!;
      assert.ok(![PROFILE_MARKER, PROJECT_MARKER].some(marker => system.includes(marker) || payload.includes(marker)), task);
    }
  } finally { await children.close(); removeDir(dir); }
});
