import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const plugin = resolve(import.meta.dirname, '..');
const data = resolve(plugin, 'fixtures/graph-edge-layout');
const read = name => JSON.parse(readFileSync(resolve(data, name), 'utf8'));
const reload = read('retry2-reload.json'), list = read('retry2-list.json'), logs = read('retry2-logs.json');
for (const command of [reload, list, logs]) assert.equal(command.exitCode, 0);
const installed = JSON.parse(list.output).find(p => p.id === 'spike-plugin');
assert.equal(resolve(installed.path), plugin);
assert.equal(resolve(installed.installation.identity.path), plugin);
assert.equal(installed.enabled, true);
assert.equal(installed.status, 'running');
assert(!installed.error);
const fresh = JSON.parse(logs.output).filter(log => Date.parse(log.timestamp) >= Date.parse(reload.startedAt));
const errors = fresh.filter(log => log.stream === 'stderr' || /failed|error/i.test(log.message));
assert.equal(errors.length, 0);
assert(fresh.some(log => log.message.includes('Plugin ready')));
for (const [path, hash] of Object.entries(read('retry2-preservation.json').hashes)) {
  assert.equal(createHash('sha256').update(readFileSync(resolve(plugin, path))).digest('hex'), hash, path);
}
writeFileSync(resolve(data, 'retry2-host-verification.json'), JSON.stringify({
  verifiedAt: new Date().toISOString(), reloadStartedAt: reload.startedAt,
  source: installed.path, enabled: installed.enabled, status: installed.status,
  commandExitCodes: [reload.exitCode, list.exitCode, logs.exitCode],
  reloadLogs: fresh, reloadErrorCount: errors.length, protectedFilesEqual: true,
}, null, 2) + '\n');
console.log('reload・ls・logs 종료 0, 설치 소스 일치, enabled true, running, reload 이후 오류 0건, 보존 파일 해시 일치');
