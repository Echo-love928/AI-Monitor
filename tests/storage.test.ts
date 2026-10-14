import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../server/db.js';
test('多个进程同时初始化 SQLite 不锁死，重启后配置与数据仍保留', async () => {
  const prefix = path.join(tmpdir(), 'signal-test-'); const directory = mkdtempSync(prefix); const filename = path.join(directory, 'signal.sqlite');
  try { await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--import', 'tsx', 'tests/db-worker.ts', filename], { windowsHide: true }))); const first = new Store(filename); assert.equal(first.list('checks').length, 4); first.put('state', 'restartProof', 'persisted'); first.close(); const second = new Store(filename); assert.equal(second.get('state', 'restartProof'), 'persisted'); second.close(); }
  finally { if (path.resolve(directory).startsWith(path.resolve(prefix))) rmSync(directory, { recursive: true, force: true }); }
});
