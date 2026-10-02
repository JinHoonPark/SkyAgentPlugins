import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';

const plugin = resolve(import.meta.dirname, '..'), root = resolve(plugin, '../..');
const dataDir = resolve(plugin, 'fixtures/graph-edge-layout');
const output = resolve(dataDir, 'retry2-preservation.json');
assert(!existsSync(output), '기존 재작업 증빙 덮어쓰기 금지');
const protectedFiles = ['fixtures/graph-edge-layout/GRAPH.md', 'fixtures/graph-edge-layout/graph.json',
  'client/spikes/graph-edge/fixture/graph.ts', 'fixtures/graph-edge-layout/measurements.json', 'index.client.tsx',
  '../../.skywork/paseo-orchestration/2026-10-01-graph-edge-spike/SPIKE.md',
  ...['N2.md', 'N2.failure.md', 'N2-retry1.md'].map(name => '../../.skywork/paseo-orchestration/2026-10-01-graph-edge-spike/nodes/' + name)];
const hashes = Object.fromEntries(protectedFiles.map(path => [path, createHash('sha256').update(readFileSync(resolve(plugin, path))).digest('hex')]));
writeFileSync(output, JSON.stringify({ recordedAt: new Date().toISOString(), hashes }, null, 2) + '\n');
const source = readFileSync(resolve(root, 'paseo-plugins/orchestration-graph/server/graphs.ts'), 'utf8');
const parserSource = 'const REQUIRED_COLUMNS = ["노드 ID", "프로필", "상태", "agentId"];\n'
  + source.slice(source.indexOf('export function parseGraphTable'), source.indexOf('export function assembleGraph'))
  + source.slice(source.indexOf('function extractMermaidBody'));
const parser = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(parserSource)).toString('base64'));
const parsed = parser.parseMermaid(readFileSync(resolve(dataDir, 'GRAPH.md'), 'utf8'));
const fixture = JSON.parse(readFileSync(resolve(dataDir, 'graph.json'), 'utf8'));
assert.deepEqual(parsed.edges, fixture.edges);
assert.deepEqual([...parsed.nodeIds].sort(), fixture.nodes.map(n => n.id).sort());
writeFileSync(resolve(plugin, 'client/spikes/graph-edge/fixture/mermaid-order.ts'),
  'export const mermaidNodeOrder = ' + JSON.stringify(parsed.nodeIds) + ' as const;\n'
  + 'export const mermaidEdgeOrder = ' + JSON.stringify(parsed.edges.map(e => e.from + '-' + e.to)) + ' as const;\n');
console.log(JSON.stringify({ tableNodeOrder: fixture.nodes.map(n => n.id), mermaidNodeOrder: parsed.nodeIds, mermaidEdgeOrder: parsed.edges.map(e => e.from + '-' + e.to) }));
