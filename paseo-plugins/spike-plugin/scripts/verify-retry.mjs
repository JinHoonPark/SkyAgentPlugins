import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'typescript';

const plugin = resolve(import.meta.dirname, '..');
const dataDir = resolve(plugin, 'fixtures/graph-edge-layout');
const evidencePath = resolve(dataDir, 'retry1-verification.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const protectedPaths = ['fixtures/graph-edge-layout/GRAPH.md', 'fixtures/graph-edge-layout/graph.json', 'index.client.tsx',
  '../../.skywork/paseo-orchestration/2026-10-01-graph-edge-spike/nodes/N2.md',
  '../../.skywork/paseo-orchestration/2026-10-01-graph-edge-spike/nodes/N2.failure.md'];
function measurementHash() {
  const values = JSON.parse(readFileSync(resolve(dataDir, 'measurements.json'), 'utf8'));
  delete values.measuredAt;
  return digest(JSON.stringify(values));
}
if (process.argv[2] === 'before') {
  assert(!existsSync(evidencePath), '기존 재작업 증빙을 덮어쓰지 않는다');
  const before = { recordedAt: new Date().toISOString(), measurementHash: measurementHash(),
    fixtureModuleHash: digest(readFileSync(resolve(dataDir, 'graph.ts'))),
    protectedHashes: Object.fromEntries(protectedPaths.map(path => [path, digest(readFileSync(resolve(plugin, path)))])) };
  writeFileSync(evidencePath, JSON.stringify({ before }, null, 2) + '\n');
  console.log('재작업 전 측정값·fixture·보존 대상 해시 기록');
} else if (process.argv[2] === 'host') {
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const reload = JSON.parse(readFileSync(resolve(dataDir, 'retry1-reload.json'), 'utf8'));
  const list = JSON.parse(readFileSync(resolve(dataDir, 'retry1-list.json'), 'utf8'));
  const logs = JSON.parse(readFileSync(resolve(dataDir, 'retry1-logs.json'), 'utf8'));
  for (const result of [reload, list, logs]) assert.equal(result.exitCode, 0);
  const entry = (Array.isArray(list.output) ? list.output : [list.output]).find(e => e.id === 'spike-plugin');
  assert.equal(resolve(entry.path).toLowerCase(), plugin.toLowerCase());
  assert.equal(entry.enabled, true); assert.equal(entry.status, 'running'); assert.equal(entry.error, undefined);
  const newLogs = logs.output.filter(line => new Date(line.timestamp) >= new Date(reload.startedAt));
  assert(newLogs.some(line => line.message === '[paseo] Plugin ready'));
  assert.equal(newLogs.filter(line => line.stream === 'stderr' || /failed|error/i.test(line.message)).length, 0);
  evidence.host = { checkedAt: new Date().toISOString(), sourceMatches: true, enabled: true, status: 'running',
    reloadExitCode: reload.exitCode, listExitCode: list.exitCode, logsExitCode: logs.exitCode, reloadStartedAt: reload.startedAt, reloadLogs: newLogs,
    historicalLoadErrors: logs.output.filter(line => new Date(line.timestamp) < new Date(reload.startedAt) && /failed|error/i.test(line.message)).length };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log('reload/list/logs 종료 0 / 워크트리 소스 일치 / enabled true / status running / reload 이후 오류 0');
} else {
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const runtimeFixture = resolve(plugin, 'client/spikes/graph-edge/fixture/graph.ts');
  assert.equal(digest(readFileSync(runtimeFixture)), evidence.before.fixtureModuleHash, '이동한 모듈 바이트 동일');
  assert.equal(measurementHash(), evidence.before.measurementHash, '측정 시각을 제외한 전체 측정값·좌표·판정 동일');
  for (const [path, hash] of Object.entries(evidence.before.protectedHashes)) assert.equal(digest(readFileSync(resolve(plugin, path))), hash, path + ' 보존');
  const visited = new Set();
  function walk(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const local = relative(plugin, file).replace(/\\/g, '/');
    if (file !== resolve(plugin, 'index.client.tsx') && file !== resolve(plugin, 'index.server.ts')) {
      assert(/^(client|server|shared)\//.test(local), '모듈 경계 위반: ' + local);
    }
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const specs = [];
    function scan(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) specs.push(node.arguments[0].text);
      ts.forEachChild(node, scan);
    }
    scan(source);
    for (const spec of specs.filter(s => s.startsWith('.'))) {
      const base = resolve(dirname(file), spec);
      const candidates = [base, base + '.ts', base + '.tsx', base + '.js', resolve(base, 'index.ts'), resolve(base, 'index.tsx')];
      const dependency = candidates.find(path => existsSync(path) && /\.(ts|tsx|js)$/.test(path));
      assert(dependency, local + ': 相対 import 解決不可: ' + spec);
      walk(dependency);
    }
  }
  walk(resolve(plugin, 'index.client.tsx')); walk(resolve(plugin, 'index.server.ts'));
  const after = { checkedAt: new Date().toISOString(), measurementHash: measurementHash(), fixtureModuleHash: digest(readFileSync(runtimeFixture)),
    measurementEqual: true, protectedFilesEqual: true, fixtureBytesEqual: true,
    bundleModules: [...visited].map(file => relative(plugin, file).replace(/\\/g, '/')).sort(),
    generatedMeasurementModulesReachable: [...visited].some(file => file.includes('.measurement-build')) };
  assert.equal(after.generatedMeasurementModulesReachable, false);
  writeFileSync(evidencePath, JSON.stringify({ before: evidence.before, after }, null, 2) + '\n');
  console.log(`측정값·좌표·판정 동일 / fixture 바이트 동일 / 보존 파일 동일 / 모듈 경계 ${visited.size}개 통과 / 측정 생성물 번들 참조 없음`);
}
