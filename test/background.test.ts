import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { COMPACT } from '../src/core/prompts.ts';
import { Children } from '../src/agents.ts';
import { Background, duration, tail } from '../src/background.ts';
import { Memory } from '../src/memory.ts';
import { alive } from '../src/runs.ts';
import { reportParts } from '../src/report-message.ts';
import { emptyUsage } from '../src/usage.ts';
import { REPORT_TYPE, textContent, withoutFullChat } from '../src/transcript.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
// Background commands run under bash, in a process group of their own: POSIX only.
const posix = { skip: process.platform === 'win32' ? 'bash and process groups are POSIX' : false };

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}
/** A command that runs until the test creates `gate` (20 seconds at most, so a failed test leaves no process behind), then prints and exits with `code`. */
const gated = (gate: string, code = 0) => `i=0; while [ ! -e '${gate}' ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; echo line one; echo campaign done; exit ${code}`;

async function setup(dir: string, model?: Parameters<ModelRuntime['registerProvider']>[1]['streamSimple'], backgroundPoll?: number) {
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const reports: string[] = [], warnings: string[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  if (model) runtime.registerProvider('optchat-test', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }], streamSimple: model });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(withoutFullChat(text)); }, text => warnings.push(text), dir, { backgroundPoll, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  return { memory, children, reports, warnings };
}

test('background returns at once and the exit report, with the log\'s tail, reaches the main agent', posix, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bg-main-')), gate = join(dir, 'gate');
  const { memory, children, reports, warnings } = await setup(dir);
  try {
    const before = Date.now();
    const text = children.startBackground({ command: gated(gate, 3), title: 'Translation campaign' }, dir);
    assert.ok(Date.now() - before < 1000, 'the tool returns without waiting for the command');
    const [job] = children.background.running;
    assert.equal(text, `Started ${job.id} (pid ${job.pid}, log ${job.log}). Its exit report will arrive as a message; don't poll or sleep, end your turn or keep working. To stop it: kill -- -${job.pid}`);
    assert.match(job.id, /^bg-[0-9a-f]{8}$/);
    assert.ok(alive(job.pid), 'the command is still running');
    assert.ok(job.log.startsWith(join(dir, 'runs', 'background')), 'its log is in the profile, under the git-ignored runs/');
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(reports, [], 'nothing is reported while it runs');
    writeFileSync(gate, '');
    await until(() => reports.length === 1);
    assert.match(reports[0], new RegExp(`^\\[${job.id}\\] Translation campaign exited 3 after \\d+s\\. Log ${job.log.replace(/[.\\]/g, '\\$&')}, last ~40 lines:\nline one\ncampaign done$`));
    assert.equal(reportParts(reports[0]).label, `background ${job.id} · exit report`);
    assert.deepEqual(children.background.running, [], 'a delivered command is forgotten');
    assert.ok(!existsSync(join(dir, 'runs', 'background', `${job.id}.json`)), 'its record is removed once delivered');
    assert.deepEqual(warnings, []);
  } finally { await children.close(); await memory.close(); removeDir(dir); }
});

test('a subagent with a background command waits for it, then gets the exit report as its next prompt', posix, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bg-child-')), gate = join(dir, 'gate');
  const prompts: string[] = [];
  const { memory, children, reports, warnings } = await setup(dir, (model, context) => {
    const stream = createAssistantMessageEventStream();
    const last = context.messages.at(-1), lastText = textContent(last && 'content' in last ? last.content : '');
    if (last?.role === 'user') prompts.push(lastText);
    const first = !context.messages.some(m => m.role === 'assistant');
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: last?.role === 'toolResult' ? 'started, ending my turn' : `heard: ${lastText}` }],
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
    if (first) { message.content = [{ type: 'toolCall', id: 'bg', name: 'background', arguments: { command: gated(gate), title: 'campaign' } }]; message.stopReason = 'toolUse'; }
    queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end(); });
    return stream;
  });
  try {
    const [id] = await children.spawn([{ task: 'run the campaign' }], dir);
    await until(() => children.history.records.get(id)?.state === 'waiting');
    assert.ok(children.live(id)?.session.getActiveToolNames().includes('background'));
    assert.equal(children.background.running[0]?.owner, id);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(children.history.records.get(id)?.state, 'waiting', 'it does not complete while its command runs');
    assert.deepEqual(reports, []);
    writeFileSync(gate, '');
    await until(() => !children.active);
    assert.match(prompts.at(-1) ?? '', /^\[bg-[0-9a-f]{8}\] campaign exited 0 after/, 'the exit report is its next prompt');
    assert.equal(reports.length, 1, 'the exit report went to the subagent, not the main agent');
    assert.match(reports[0], new RegExp(`^\\[${id}\\] heard: \\[bg-[0-9a-f]{8}\\] campaign exited 0 after .*campaign done$`, 's'));
    assert.deepEqual(warnings, []);
  } finally { await children.close(); await memory.close(); removeDir(dir); }
});

test('after a Pi restart the next start re-attaches to a command still running, and its owner being gone sends the report to the main agent', posix, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bg-restart-')), gate = join(dir, 'gate'), quick = join(dir, 'quick');
  const first = await setup(dir);
  try {
    first.children.startBackground({ command: gated(gate, 7) }, dir, 'gone1234');
    first.children.startBackground({ command: gated(quick) }, dir);
    const [owned, mine] = first.children.background.running;
    await first.children.close(); // Pi closes or reloads; the commands keep running.
    assert.ok(alive(owned.pid) && alive(mine.pid), 'closing Pi leaves the commands running');
    const restarted = await setup(dir, undefined, 20);
    assert.deepEqual(restarted.children.background.running.map(job => job.id).sort(), [owned.id, mine.id].sort(), 'the next start knows both from their records');
    assert.equal(restarted.children.background.pending('gone1234').length, 1, 'a resumed owner would wait for it');
    writeFileSync(quick, ''); writeFileSync(gate, '');
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(restarted.reports, [], 'nothing is delivered before the restart is ready to watch');
    restarted.children.background.watch();
    await until(() => restarted.reports.length === 2);
    const byId = (id: string) => restarted.reports.find(text => text.startsWith(`[${id}]`)) ?? '';
    assert.match(byId(owned.id), /exited 7 after .*campaign done\n\n\(Started by subagent gone1234, which is no longer running\.\)$/s);
    assert.match(byId(mine.id), /exited 0 after/);
    assert.deepEqual(first.reports, [], 'the closed Pi delivers nothing');
    assert.deepEqual(new Background(join(dir, 'runs', 'background'), async () => {}, () => {}).running, [], 'delivered commands are not re-attached again');
    await restarted.children.close(); await restarted.memory.close();
  } finally { await first.memory.close(); removeDir(dir); }
});

test('a killed command reports that it ended without an exit code; tails and durations stay short', posix, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bg-kill-'));
  const texts: string[] = [];
  const background = new Background(dir, async (_job, text) => { texts.push(text); }, error => { throw new Error(error); }, 20);
  try {
    const job = background.start({ command: 'sleep 30', cwd: dir });
    process.kill(-job.pid, 'SIGTERM'); // what the start message tells the agent: kill -- -<pid>
    await until(() => texts.length === 1);
    assert.match(texts[0], new RegExp(`^\\[${job.id}\\] sleep 30 ended without an exit code`));
    assert.throws(() => background.start({ command: 'true', cwd: join(dir, 'missing') }), /No such directory/);
    writeFileSync(join(dir, 'long.log'), Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'));
    assert.equal(tail(join(dir, 'long.log')).split('\n').length, 41, '40 lines after an ellipsis');
    assert.equal(duration(3 * 3600_000 + 12 * 60_000), '3h 12m');
    assert.equal(duration(65_000), '1m 5s');
  } finally { background.close(); removeDir(dir); }
});

test('in Pi, the main agent\'s background call ends its turn at once, and the exit report starts its next turn', posix, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-bg-pi-')), gate = join(dir, 'gate');
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const prompts: string[] = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    saveConfig(profilePath('fixture'), { ...loadConfig(profilePath('fixture')), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
        const last = context.messages.at(-1), text = textContent(last && 'content' in last ? last.content : '');
        if (!compression && last?.role === 'user') prompts.push(text);
        const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: compression ? 'Summary.' : last?.role === 'toolResult' ? 'Started it.' : 'Noted.' }],
          timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
        if (!compression && text.endsWith('Run the campaign.')) { reply.content = [{ type: 'toolCall', id: 'bg', name: 'background', arguments: { command: gated(gate), title: 'campaign' } }]; reply.stopReason = 'toolUse'; }
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply }); stream.end(); });
        return stream;
      } });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date', 'background'] })).session;
    await session.bindExtensions({});
    assert.ok(session.getActiveToolNames().includes('background'));
    await session.prompt('Run the campaign.');
    await session.agent.waitForIdle();
    assert.ok(session.messages.some(m => m.role === 'toolResult' && /^Started bg-[0-9a-f]{8} \(pid \d+, log /.test(textContent(m.content))), 'the tool answered at once');
    assert.equal(session.getLastAssistantText(), 'Started it.', 'the turn ended while the command runs');
    const turns = prompts.length;
    writeFileSync(gate, '');
    await until(() => prompts.length > turns);
    await session.agent.waitForIdle();
    assert.match(prompts.at(-1) ?? '', /\[bg-[0-9a-f]{8}\] campaign exited 0 after \d+s\. Log .*campaign done$/s, 'the exit report is the main agent\'s next prompt');
    assert.ok(manager.getBranch().some(e => e.type === 'custom_message' && e.customType === REPORT_TYPE && textContent(e.content).startsWith('[bg-')), 'shown as a report message');
    const main = join(dir, 'profiles', 'fixture', 'main');
    const log = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => JSON.parse(line) as { kind: string; text: string });
    assert.ok(log.some(e => e.kind === 'work' && e.text.startsWith('[bg-')), 'kept in memory as work');
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});
