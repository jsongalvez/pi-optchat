import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Type } from 'typebox';
import { alive } from './runs.ts';
import { atomicWrite } from './store.ts';
import { oneLine } from './inspector.ts';
import { result } from './core/tools.ts';

// Background commands: an agent starts a long command, gets control back at once, and gets one message when it exits, through
// the same paths a subagent's report takes. Nothing wakes a model before then: the wait is a process exit, seen by this process
// (or, after a Pi restart, by a coarse poll of the pid and the exit file, which costs no model tokens).

/** What survives a Pi restart, one JSON file per command; `owner` is the subagent that started it, unset for the main agent. */
export interface Job { id: string; pid: number; command: string; title?: string; cwd: string; owner?: string; log: string; exit: string; started: number }
const isJob = (value: unknown): value is Job => !!value && typeof value === 'object' && ['id', 'command', 'cwd', 'log', 'exit'].every(key => typeof (value as Record<string, unknown>)[key] === 'string')
  && typeof (value as Job).pid === 'number' && typeof (value as Job).started === 'number';
interface Tracked { job: Job; done: Promise<void>; resolve: () => void; finishing?: boolean }
/** Delivers a command's exit report to whoever should read it. */
type Deliver = (job: Job, text: string) => Promise<void>;

const TAIL_LINES = 40, TAIL_BYTES = 8192;
/** The last lines of a log, at most TAIL_BYTES of them, so a chatty command can't flood the agent's context. */
export function tail(path: string, lines = TAIL_LINES) {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return '(no log)'; }
  try {
    const size = fstatSync(fd).size, length = Math.min(size, TAIL_BYTES), buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const all = buffer.toString('utf8').replace(/\n$/, '').split('\n');
    const kept = all.slice(-lines);
    return kept.length < all.length || size > length ? `…\n${kept.join('\n')}` : kept.join('\n') || '(empty)';
  } finally { closeSync(fd); }
}
export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}
const label = (job: Job) => job.title || (oneLine(job.command).length > 120 ? `${oneLine(job.command).slice(0, 117)}...` : oneLine(job.command));
/** The one message a command's end produces; `code` is undefined when it ended without writing one (killed). */
export const exitReport = (job: Job, code: number | undefined, ended: number) =>
  `[${job.id}] ${label(job)} ${code === undefined ? 'ended without an exit code (killed, or its wrapper died)' : `exited ${code}`} after ${duration(ended - job.started)}. Log ${job.log}, last ~${TAIL_LINES} lines:\n${tail(job.log)}`;
export const STARTED = (job: Job) => `Started ${job.id} (pid ${job.pid}, log ${job.log}). Its exit report will arrive as a message; don't poll or sleep, end your turn or keep working. To stop it: kill -- -${job.pid}`;

// The wrapper runs the command in a bash of its own and writes its exit code to a file once it ends, so a Pi started later still learns it.
const WRAPPER = 'bash -c "$1"; code=$?; printf "%s\\n" "$code" > "$2.tmp" && mv "$2.tmp" "$2"; exit $code';

export class Background {
  private readonly jobs = new Map<string, Tracked>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  /** `directory` holds each command's record, log and exit file; `poll` is how often a command this Pi did not start is checked. */
  constructor(private readonly directory: string, private readonly deliver: Deliver, private readonly warn: (text: string) => void, private readonly poll = 15_000) {
    for (const file of existsSync(directory) ? readdirSync(directory).filter(f => f.endsWith('.json')) : []) {
      try {
        const job: unknown = JSON.parse(readFileSync(join(directory, file), 'utf8'));
        if (isJob(job) && file === `${job.id}.json`) this.track(job);
      } catch (error) { warn(`Could not read background command ${file}: ${String(error)}`); }
    }
  }
  private track(job: Job) {
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    const tracked: Tracked = { job, done, resolve };
    this.jobs.set(job.id, tracked);
    return tracked;
  }
  /** Commands still running for `owner` (a subagent ID; undefined for the main agent): each resolves once its report is delivered. */
  pending(owner: string | undefined) { return [...this.jobs.values()].filter(t => t.job.owner === owner).map(t => t.done); }
  get running() { return [...this.jobs.values()].map(t => t.job); }
  start({ command, cwd, title, owner }: { command: string; cwd: string; title?: string; owner?: string }) {
    if (this.closed) throw new Error('Profile is closing.');
    if (!command.trim()) throw new Error('Command is empty.');
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`No such directory: ${cwd}`);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const id = `bg-${randomUUID().slice(0, 8)}`, log = join(this.directory, `${id}.log`), exit = join(this.directory, `${id}.exit`);
    const fd = openSync(log, 'a');
    let pid: number | undefined;
    try {
      // Detached: a process group of its own, so neither Pi closing nor a Ctrl+C in Pi's terminal ends it.
      const child = spawn('bash', ['-c', WRAPPER, 'optchat-background', command, exit], { cwd, detached: true, stdio: ['ignore', fd, fd] });
      child.on('error', error => this.warn(`Background command ${id} failed to start: ${String(error)}`));
      child.on('exit', () => { void this.check(id); });
      child.unref();
      pid = child.pid;
    } finally { closeSync(fd); }
    if (pid === undefined) throw new Error('Could not start bash.');
    const job: Job = { id, pid, command, ...(title?.trim() ? { title: oneLine(title).trim().slice(0, 128) } : {}), cwd, ...(owner ? { owner } : {}), log, exit, started: Date.now() };
    atomicWrite(join(this.directory, `${id}.json`), JSON.stringify(job));
    this.track(job);
    return job;
  }
  /** Starts the coarse poll that notices commands an earlier Pi started; call it once the runs they may report to are resumed. */
  watch() {
    if (this.closed || this.timer) return;
    const sweep = () => { for (const id of this.jobs.keys()) void this.check(id); };
    this.timer = setInterval(sweep, this.poll);
    this.timer.unref();
    sweep();
  }
  private async check(id: string) {
    const tracked = this.jobs.get(id);
    if (!tracked || tracked.finishing || this.closed) return;
    const { job } = tracked;
    let code: number | undefined, ended = Date.now();
    if (existsSync(job.exit)) {
      const text = readFileSync(job.exit, 'utf8').trim();
      code = /^\d+$/.test(text) ? Number(text) : undefined;
      try { ended = statSync(job.exit).mtimeMs; } catch { /* the exit time is then now */ }
    } else if (alive(job.pid)) return;
    tracked.finishing = true;
    try {
      await this.deliver(job, exitReport(job, code, ended));
      rmSync(join(this.directory, `${job.id}.json`), { force: true });
    } catch (error) { this.warn(`Could not deliver the report of ${job.id}; the next start tries again: ${String(error)}`); }
    this.jobs.delete(id);
    tracked.resolve();
  }
  /** Pi is closing: stop watching. The commands keep running, and the next start re-attaches to them. */
  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

const DESCRIPTION = 'Run a shell command in the background and get control back at once. Use it for anything that may take more than a minute or two (a build, a test suite, a long script or campaign, a deploy, waiting for CI with `gh run watch`) instead of a long bash timeout, sleep or polling. It runs detached under bash, its output goes to a log file, and one message starting "[bg-<id>]" with its exit code and the log\'s last lines arrives when it ends. Never poll or sleep for it: keep working or end your turn.';
/** The `background` tool; `start` returns the tool's answer. */
export const backgroundTool = (start: (args: { command: string; cwd?: string; title?: string }) => string) => ({
  name: 'background', label: 'Run in background', description: DESCRIPTION,
  parameters: Type.Object({ command: Type.String({ description: 'Shell command, run with bash -c' }),
    cwd: Type.Optional(Type.String({ description: 'Directory to run it in (~ allowed); defaults to your current directory' })),
    title: Type.Optional(Type.String({ description: 'Short label for its exit report' })) }),
  execute: async (_id: string, args: { command: string; cwd?: string; title?: string }) => result(start(args)),
});
