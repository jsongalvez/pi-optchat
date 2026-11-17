import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyConfig, defaults, loadConfig, saveConfig } from '../src/profiles.ts';
import { removeDir } from './support.ts';

test('a settings save keeps keys written to config.json after Pi read it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lost-update-'));
  try {
    saveConfig(dir, { ...defaults });
    const running = loadConfig(dir);                       // the copy a running Pi holds
    const file = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...file, project: '~/Work/repo' }, null, 2));  // edited meanwhile
    const subagent = { provider: 'p', model: 'm', thinking: 'low' } as const;
    applyConfig(dir, running, { subagent });
    const saved = loadConfig(dir);
    assert.equal(saved.project, '~/Work/repo');
    assert.deepEqual(saved.subagent, subagent);
    assert.equal(running.project, '~/Work/repo');
    assert.deepEqual(running.subagent, subagent);
  } finally { removeDir(dir); }
});
