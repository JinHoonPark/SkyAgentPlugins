import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../../..');
const destination = resolve(import.meta.dirname, '../fixtures/graph-edge-layout');
const source = readFileSync(resolve(root, 'paseo-plugins/orchestration-graph/server/graphs.ts'), 'utf8');
const parserSource = 'const REQUIRED_COLUMNS = ["노드 ID", "프로필", "상태", "agentId"];\n'
  + source.slice(source.indexOf('export function parseGraphTable'), source.indexOf('export function assembleGraph'))
  + source.slice(source.indexOf('function extractMermaidBody'));
const parser = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(parserSource)).toString('base64'));
// 원본은 이 한 번만 읽고, 이후 비교는 고정 복사본만 사용한다.
const bytes = readFileSync(process.argv[2]);
const copiedAt = new Date().toISOString();
writeFileSync(resolve(destination, 'GRAPH.md'), bytes);
const copied = readFileSync(resolve(destination, 'GRAPH.md'));
assert.deepEqual(copied, bytes);
const markdown = copied.toString('utf8');
const table = parser.parseGraphTable(markdown);
assert.equal(table.ok, true);
const mermaid = parser.parseMermaid(markdown);
const body = markdown.match(/```mermaid[^\n]*\n([\s\S]*?)```/)[1];
// 선언 대조는 파서의 토큰을 이용하되, 파싱 결과의 중복 제거와 별개로 모든 선언을 확인한다.
const inspect = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(parserSource + '\nexport { tokenizeMermaidLine };')).toString('base64'));
let declaredEdges = 0;
for (const line of body.split(/\r?\n/)) {
  const tokens = inspect.tokenizeMermaidLine(line);
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i], arrow = tokens[i + 1], b = tokens[i + 2];
    if (a?.kind === 'node' && a.label != null) {
      assert.deepEqual(mermaid.labels[a.id], a.label.split('<br/>'));
      if (a.shape === 'hexagon') assert.equal(mermaid.shapes[a.id], 'hexagon');
    }
    if (a?.kind === 'node' && arrow?.kind === 'arrow' && b?.kind === 'node') {
      assert(mermaid.edges.some(e => e.from === a.id && e.to === b.id && e.label === arrow.label && e.dashed === arrow.dashed));
      declaredEdges++;
    }
  }
}
assert.equal(declaredEdges, mermaid.edges.length);
assert.deepEqual([...mermaid.nodeIds].sort(), table.rows.map(r => r.id).sort());
const pairs = mermaid.edges.filter(e => e.from < e.to && mermaid.edges.some(r => r.from === e.to && r.to === e.from)).map(e => [e.from, e.to]);
const metadata = {
  copiedAt, sha256: createHash('sha256').update(copied).digest('hex'),
  tableRows: table.rows.length, nodes: mermaid.nodeIds.length, directions: mermaid.edges.length,
  reciprocalPairs: pairs, hexagons: Object.keys(mermaid.shapes).length,
  dashed: mermaid.edges.filter(e => e.dashed).length,
  parserSourceSha256: createHash('sha256').update(source).digest('hex'),
  declarationAudit: '모든 노드 선언·도형·방향·라벨·속성 대조 통과; frontmatter 노드 없음',
};
const fixture = { metadata, nodes: table.rows.map(r => ({ id: r.id, profile: r.profile, tableStatus: r.tableStatus,
  status: ['대기', '실행 중', '완료', '실패', '생략'].includes(r.tableStatus) ? r.tableStatus : null,
  displayName: r.profile, fromTable: true, labelLines: mermaid.labels[r.id] ?? [r.profile], shape: mermaid.shapes[r.id] ?? 'rect',
})), edges: mermaid.edges };
writeFileSync(resolve(destination, 'graph.json'), JSON.stringify(fixture, null, 2) + '\n');
const runtimeFixture = resolve(import.meta.dirname, '../client/spikes/graph-edge/fixture');
mkdirSync(runtimeFixture, { recursive: true });
writeFileSync(resolve(runtimeFixture, 'graph.ts'), 'export default ' + JSON.stringify(fixture, null, 2) + ' as const;\n');
console.log(JSON.stringify(metadata));
