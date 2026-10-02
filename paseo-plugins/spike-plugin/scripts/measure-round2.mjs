import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'typescript';

const plugin = resolve(import.meta.dirname, '..'), root = resolve(plugin, '../..');
const folder = resolve(plugin, 'client/spikes/graph-edge'), dataDir = resolve(plugin, 'fixtures/graph-edge-layout');
const output = resolve(import.meta.dirname, '.measurement-build');
const protectedData = JSON.parse(readFileSync(resolve(dataDir, 'retry2-preservation.json'), 'utf8'));
for (const [path, hash] of Object.entries(protectedData.hashes)) assert.equal(createHash('sha256').update(readFileSync(resolve(plugin, path))).digest('hex'), hash, path + ' 보존');
const originalMotion = readFileSync(resolve(root, 'paseo-plugins/orchestration-graph/client/motion-logic.ts'), 'utf8').replace(/\r\n/g, '\n');
assert.equal(readFileSync(resolve(folder, 'motion-logic.ts'), 'utf8').replace(/\r\n/g, '\n').replace('./graph-types', '../shared/graphs'), originalMotion);
const vendorSource = readFileSync(resolve(folder, 'vendor/dagre.js'), 'utf8');
assert.equal(vendorSource, readFileSync(resolve(root, 'paseo-plugins/orchestration-graph/client/vendor/dagre.js'), 'utf8'));
const start = vendorSource.indexOf('function Ue(e, n) {'), end = vendorSource.indexOf('function ft(e, n) {');
assert(start > 0 && end > start);
const cycleBlock = vendorSource.slice(start, end).replace('function Ue(e, n) {',
  'function Ue(e, n) { globalThis.__round2CycleTrace.push({ nodes: e.nodes(), edges: e.edges(), sources: e.sources(), reversed: [] });')
  .replace('let i = e.edge(o);', 'globalThis.__round2CycleTrace.at(-1).reversed.push(o); let i = e.edge(o);');
const instrumentedVendor = vendorSource.slice(0, start) + cycleBlock + vendorSource.slice(end);
globalThis.__round2CycleTrace = [];
const compiled = new Map();
function compile(file) {
  if (compiled.has(file)) return compiled.get(file);
  const destination = resolve(output, relative(plugin, file).replace(/\.(ts|js)$/, '.mjs'));
  compiled.set(file, destination);
  let source = file.endsWith('/vendor/dagre.js') || file.endsWith('\\vendor\\dagre.js') ? instrumentedVendor : readFileSync(file, 'utf8');
  if (extname(file) === '.ts') source = stripTypeScriptTypes(source);
  source = source.replace(/\bfrom\s+(['"])(\.[^'"]+)\1/g, (_, quote, specifier) => {
    let dependency = resolve(dirname(file), specifier);
    if (!extname(dependency)) dependency += existsSync(dependency + '.ts') ? '.ts' : '.js';
    let target = relative(dirname(destination), compile(dependency)).replace(/\\/g, '/');
    if (!target.startsWith('.')) target = './' + target;
    return 'from ' + quote + target + quote;
  });
  mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, source); return destination;
}
const { ROUND2_CANDIDATES, round2Layout, makeDagre, basisPoints, curveSegments, isFeedback } = await import(pathToFileURL(compile(resolve(folder, 'round2.ts'))).href);
const { layoutGraph } = await import(pathToFileURL(compile(resolve(folder, 'motion-logic.ts'))).href);
const { viewFor, pointsOf } = await import(pathToFileURL(compile(resolve(folder, 'experiment.ts'))).href);
const { metrics } = await import(pathToFileURL(compile(resolve(folder, 'metrics.ts'))).href);
const { default: dagre } = await import(pathToFileURL(compile(resolve(folder, 'vendor/dagre.js'))).href);
const view = viewFor();
globalThis.__round2CycleTrace = [];
const realBaseline = layoutGraph(null, view.nodes, view.edges, false);
const baselineTrace = globalThis.__round2CycleTrace[0];
assert.deepEqual(baselineTrace.nodes, view.nodes.map(n => n.id));
assert.deepEqual(baselineTrace.edges.map(e => e.v + '-' + e.w), view.edges.map(e => e.from + '-' + e.to));
assert.deepEqual(baselineTrace.sources, ['N12', 'N13']);
assert(baselineTrace.reversed.some(e => e.v === 'G3' && e.w === 'N4'), '원인 재현: 본 흐름 G3→N4가 순환 제거에서 뒤집힘');
const controls = [];
for (const [name, input] of [
  ['노드 삽입 순서만 역순', { ...view, nodes: [...view.nodes].reverse() }],
  ['엣지 삽입 순서만 역순', { ...view, edges: [...view.edges].reverse() }],
  ['추가 실행 노드 N12/N13의 입력 연결 제외(원인 분리용)', { ...view, nodes: view.nodes.filter(n => !['N12', 'N13'].includes(n.id)), edges: view.edges.filter(e => !['N12', 'N13'].includes(e.from)) }],
]) {
  globalThis.__round2CycleTrace = []; const { g } = makeDagre(input, false, false); dagre.layout(g);
  controls.push({ name, trace: globalThis.__round2CycleTrace[0], ranks: input.nodes.map(n => ({ id: n.id, rank: g.node(n.id).rank, y: g.node(n.id).y })) });
}
// basis의 끝점·직선 보존과 짧은 View 분할을 확인한다.
assert.deepEqual(basisPoints([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }]).at(-1), { x: 60, y: 0 });
const rightAngle = basisPoints([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }]);
assert.deepEqual(rightAngle[0], { x: 0, y: 0 }); assert.deepEqual(rightAngle.at(-1), { x: 40, y: 40 });
assert(rightAngle.some(p => p.x < 40 && p.y > 0), '꺾임점 내부에 basis 곡선 생성');
assert(curveSegments(rightAngle, 'test').every(s => s.width <= 8 + 1e-7));
const rows = [];
for (const compact of [false, true]) for (const candidate of ROUND2_CANDIDATES) {
  globalThis.__round2CycleTrace = [];
  const result = round2Layout(view, compact, candidate), trace = globalThis.__round2CycleTrace[0];
  const physical = result.placed.paths.map(p => ({ key: p.key, directions: [view.edges.find(e => e.from === p.from && e.to === p.to)], points: pointsOf(p.segments) }));
  const values = metrics(view, { placed: result.placed, physical, labels: [], options: {}, measuredLabels: false, lanes: { left: [], right: [] }, routeFailures: [], classifications: [] });
  const upstream = view.edges.filter(e => !isFeedback(e.label) && result.placed.boxes.get(e.to).top + result.placed.boxes.get(e.to).height / 2 < result.placed.boxes.get(e.from).top + result.placed.boxes.get(e.from).height / 2);
  assert.equal(result.placed.paths.length, view.edges.length);
  for (const edge of view.edges) {
    const path = result.placed.paths.find(p => p.from === edge.from && p.to === edge.to);
    assert(path && path.label === edge.label && path.dashed === edge.dashed);
  }
  if (candidate.order) {
    const main = ['N1', 'G1', 'N3', 'G3', 'N4', 'G4', 'N5'];
    assert(main.slice(1).every((id, i) => result.placed.boxes.get(id).top > result.placed.boxes.get(main[i]).top), '승인된 본 흐름 순서');
    assert(upstream.every(e => e.from === 'N9' && e.to === 'N7'));
    const request = result.rawPoints['N1-G1'], feedback = [...result.rawPoints['G1-N1']].reverse();
    assert.notDeepEqual(request, feedback, '왕복 두 방향은 서로 다른 물리 경로');
  }
  if (!candidate.order && !candidate.curve && !compact) assert.deepEqual(result.placed, realBaseline);
  if (candidate.curve) for (const path of result.placed.paths) {
    assert(path.segments.every(s => s.width <= 8 + 1e-7));
    const source = result.rawPoints[path.key], last = path.segments.at(-1);
    assert(Math.abs(last.left + Math.cos(last.deg * Math.PI / 180) * last.width - source.at(-1).x) < 1e-6);
    assert(Math.abs(last.top + 1 + Math.sin(last.deg * Math.PI / 180) * last.width - source.at(-1).y) < 1e-6);
    const tangent = Math.atan2(source.at(-1).y - source.at(-2).y, source.at(-1).x - source.at(-2).x) * 180 / Math.PI;
    assert(Math.abs(last.deg - tangent) < 1e-6);
  }
  rows.push({ compact, id: candidate.id, title: candidate.title, description: candidate.description, crossings: values.crossings, totalLength: values.totalLength,
    upstreamNonFeedbackCount: upstream.length, upstreamNonFeedback: upstream, ranks: result.ranks, reversalTrace: trace,
    feedbackInvertedForLayout: result.input.edges.filter(e => e.reversedForLayout).map(e => e.key), physicalPaths: result.placed.paths.length,
    viewSegments: result.placed.segments.length, coordinates: { boxes: [...result.placed.boxes], paths: result.placed.paths } });
  console.log(`${compact ? 'compact' : 'normal'} ${candidate.title}: 교차 ${values.crossings}, 총 길이 ${values.totalLength.toFixed(2)}px, 본 흐름 역행 ${upstream.length}, 경로 ${result.placed.paths.length}`);
}
// 곡선 후보는 노드 배치 요인을 바꾸지 않는다.
for (const compact of [false, true]) for (const pair of [['baseline','curve'], ['order','orderCurve']]) {
  const left = rows.find(r => r.compact === compact && r.id === pair[0]), right = rows.find(r => r.compact === compact && r.id === pair[1]);
  assert.deepEqual(left.ranks, right.ranks); assert.deepEqual(left.coordinates.boxes, right.coordinates.boxes);
}
// 실제 화면에 연결된 모듈 경계를 검사한다. 측정용 생성물은 도달하지 않아야 한다.
const visited = new Set();
function walk(file) {
  if (visited.has(file)) return; visited.add(file);
  const local = relative(plugin, file).replace(/\\/g, '/');
  if (!['index.client.tsx', 'index.server.ts'].includes(local)) assert(/^(client|server|shared)\//.test(local), local);
  const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = [];
  function scan(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, scan);
  }
  scan(tree);
  for (const spec of imports.filter(i => i.startsWith('.'))) {
    const base = resolve(dirname(file), spec), path = [base, base + '.ts', base + '.tsx', base + '.js', resolve(base, 'index.ts')].find(p => /\.(ts|tsx|js)$/.test(p) && existsSync(p));
    assert(path, spec); walk(path);
  }
}
walk(resolve(plugin, 'index.client.tsx')); walk(resolve(plugin, 'index.server.ts'));
assert.deepEqual(ROUND2_CANDIDATES.map(c => c.title), ['개선 전', '배치 순서', '곡선', '배치 순서 + 곡선']);
assert(ROUND2_CANDIDATES.every(c => c.description.length > 0));
const screen = ts.createSourceFile('screen.tsx', readFileSync(resolve(folder, 'screen.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const controlLabels = [];
function inspectControls(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'button') {
    const first = node.arguments[0];
    if (ts.isStringLiteral(first)) controlLabels.push(first.text);
    else assert(ts.isPropertyAccessExpression(first) && first.getText(screen) === 'candidate.title', '승인되지 않은 화면 조작');
  }
  ts.forEachChild(node, inspectControls);
}
inspectControls(screen);
assert.deepEqual(controlLabels, ['전체 보기', '원래 크기 100%', '전 화면', '후 화면']);
writeFileSync(resolve(dataDir, 'measurements-round2.json'), JSON.stringify({ measuredAt: new Date().toISOString(), fixtureSha256: JSON.parse(readFileSync(resolve(dataDir, 'graph.json'), 'utf8')).metadata.sha256,
  baselineInsertionAndCycleRemoval: baselineTrace, controls, results: rows, bundleModules: [...visited].map(p => relative(plugin, p).replace(/\\/g, '/')).sort(),
  protectedFilesEqual: true, screenControls: { candidates: ROUND2_CANDIDATES.map(c => ({ title: c.title, description: c.description })), controlLabels },
  curve: { type: 'cubic basis B-spline', maxViewLength: 8, controlPointFlatness: 0.2, originalEndpointsAndTangentsPreserved: true } }, null, 2) + '\n');
console.log('원인 재현·본 흐름 rank·basis 끝점/접선·29관계 보존·모듈 경계·이전 파일 보존 assertion 통과');
