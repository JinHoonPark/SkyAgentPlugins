import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';

const plugin = resolve(import.meta.dirname, '..'), root = resolve(plugin, '../..');
const output = resolve(import.meta.dirname, '.measurement-build');
const fixturePath = resolve(plugin, 'fixtures/graph-edge-layout');
const fixture = JSON.parse(readFileSync(resolve(fixturePath, 'graph.json'), 'utf8'));
assert.equal(createHash('sha256').update(readFileSync(resolve(fixturePath, 'GRAPH.md'))).digest('hex'), fixture.metadata.sha256);
assert.equal(readFileSync(resolve(plugin, 'client/spikes/graph-edge/fixture/graph.ts'), 'utf8'), 'export default ' + JSON.stringify(fixture, null, 2) + ' as const;\n');
const sourcePath = resolve(root, 'paseo-plugins/orchestration-graph/client');
const localPath = resolve(plugin, 'client/spikes/graph-edge');
const canonical = text => text.replace(/\r\n/g, '\n');
assert.equal(canonical(readFileSync(resolve(localPath, 'motion-logic.ts'), 'utf8')).replace('./graph-types', '../shared/graphs'), canonical(readFileSync(resolve(sourcePath, 'motion-logic.ts'), 'utf8')));
assert.deepEqual(readFileSync(resolve(localPath, 'vendor/dagre.js')), readFileSync(resolve(sourcePath, 'vendor/dagre.js')));
const originalCanvas = canonical(readFileSync(resolve(sourcePath, 'graph-canvas.tsx'), 'utf8'));
const baselineCanvas = canonical(readFileSync(resolve(localPath, 'baseline-canvas.tsx'), 'utf8'));
// 원래 카드·육각형·선·화살촉 구현 전체를 함수 단위로 대조한다.
for (const [begin, end] of [['const NodeBoxView = memo(', '/** 잘린 엣지 라벨의 전체 문구']]) {
  assert.equal(baselineCanvas.slice(baselineCanvas.indexOf(begin), baselineCanvas.indexOf(end)), originalCanvas.slice(originalCanvas.indexOf(begin), originalCanvas.indexOf(end)));
}
const baselineAudit = { layout: '원문 전체 일치(타입 import 경로 제외)', dagre: '바이트 동일',
  cardsAndArrows: 'NodeBoxView·GateArm·dashPieces·arrowHeadStyle·EdgeSegmentView 원문 동일',
  instrumentation: '라벨 onLayout 콜백·누름 툴팁·후보 overlay 옵션 추가. B 옵션은 원래 경로·접점·라벨 위치·레이어·상태 연출을 유지',
  hostEquivalence: '미검증: 다른 설치 소스이므로 새 코드 로드 확인 불가' };

const compiled = new Map();
function compile(file) {
  if (compiled.has(file)) return compiled.get(file);
  const destination = resolve(output, relative(plugin, file).replace(/\.(ts|js)$/, '.mjs'));
  compiled.set(file, destination);
  let source = readFileSync(file, 'utf8');
  if (extname(file) === '.ts') source = stripTypeScriptTypes(source);
  source = source.replace(/\bfrom\s+(['"])(\.[^'"]+)\1/g, (match, quote, specifier) => {
    let dependency = resolve(dirname(file), specifier);
    if (!extname(dependency)) {
      try { readFileSync(dependency + '.ts'); dependency += '.ts'; }
      catch { dependency += '.js'; }
    }
    const target = compile(dependency);
    let importPath = relative(dirname(destination), target).replace(/\\/g, '/');
    if (!importPath.startsWith('.')) importPath = './' + importPath;
    return 'from ' + quote + importPath + quote;
  });
  mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, source);
  return destination;
}
const experimentModule = await import(pathToFileURL(compile(resolve(localPath, 'experiment.ts'))).href);
const metricModule = await import(pathToFileURL(compile(resolve(localPath, 'metrics.ts'))).href);
const { CANDIDATES, experiment, viewFor, polygon, pierces, intersection } = experimentModule;
const { metrics, thresholds } = metricModule;
assert.deepEqual(intersection({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }), { x: 5, y: 5 });
const hex = polygon({ id: 'h', left: 0, top: 0, width: 100, height: 80 }, 'hexagon');
assert.equal(pierces({ x: -5, y: 40 }, { x: 105, y: 40 }, hex), true);
assert.equal(pierces({ x: -5, y: 1 }, { x: 5, y: 1 }, hex), false);
const fixtureView = viewFor();
const results = [];
for (const compact of [false, true]) {
  const baseline = experiment(fixtureView, compact, {}), b = metrics(fixtureView, baseline);
  const rows = [];
  for (const candidate of CANDIDATES) {
    const ex = experiment(fixtureView, compact, candidate.options), c = metrics(fixtureView, ex);
    const checks = thresholds(b, c, Boolean(candidate.options.merge), fixture.metadata.directions, fixture.metadata.reciprocalPairs.length);
    const targetImproved = candidate.options.merge ? c.physicalPaths < b.physicalPaths : candidate.options.ports ? (c.minPortDistance ?? 0) > (b.minPortDistance ?? 0)
      : candidate.options.lanes || candidate.options.orthogonal ? c.crossings < b.crossings || c.penetratingPairs < b.penetratingPairs
      : candidate.options.avoidLabels || candidate.options.reserveLabels ? null : candidate.options.priority ? '기하학 개선 아님' : candidate.options.spacing ? c.crossings < b.crossings : false;
    const repeats = [1, 2, 3].map(() => experiment(fixtureView, compact, candidate.options));
    const coordinate = result => JSON.stringify({ boxes: [...result.placed.boxes], paths: result.physical, labels: result.labels });
    assert(repeats.every(result => coordinate(result) === coordinate(ex)));
    if (candidate.options.merge) {
      assert.equal(c.physicalPaths, fixture.metadata.directions - fixture.metadata.reciprocalPairs.length);
      assert.equal(c.logicalDirections, fixture.metadata.directions); assert.equal(c.missingInformation, 0);
    }
    rows.push({ id: candidate.id, title: candidate.title, options: candidate.options, metrics: c, thresholds: checks,
      targetImproved, staticCoordinateRepeats: 3, staticRepeatEqual: true,
      screenReopensAndAnimation: '미검증', classificationDifferences: ex.classifications,
      coordinates: { boxes: [...ex.placed.boxes], physical: ex.physical, labels: ex.labels } });
    console.log(`${compact ? 'compact' : 'normal'} ${candidate.id}: crossings=${c.crossings}, penetration=${c.penetratingPairs}, paths=${c.physicalPaths}, length=${c.totalLength.toFixed(1)}, bends=${c.maxBends}`);
  }
  // 결합 순서를 유지한다. 악화되는 추가분은 제외하고, 라벨 실측 없는 단계는 판정하지 않는다.
  const combinations = [];
  let accepted = {}, previous = b;
  const notWorse = (c, p) => c.crossings <= p.crossings && c.penetratingPairs <= p.penetratingPairs && c.densePairs <= p.densePairs
    && c.overlapLength <= p.overlapLength + 1e-5 && c.totalLength <= p.totalLength && c.maxBends <= p.maxBends;
  const portCandidates = rows.filter(r => r.id.startsWith('onePorts')).sort((a, c) => c.metrics.minPortDistance - a.metrics.minPortDistance);
  const stages = [
    { stage: '왕복 한 선+접점 분산', added: portCandidates[0]?.options },
    { stage: '라벨 회피', added: null },
    { stage: '복귀 레인', added: rows.filter(r => ['return12', 'return20', 'kind12', 'kind20'].includes(r.id) && r.targetImproved === true).sort((a, c) => a.metrics.crossings - c.metrics.crossings)[0]?.options },
    { stage: '직교화', added: rows.find(r => r.id === 'orthogonal' && r.targetImproved === true)?.options },
  ];
  for (const stage of stages) {
    if (!stage.added) { combinations.push({ stage: stage.stage, status: stage.stage === '라벨 회피' ? '미검증: 실제 라벨 크기 없음' : '제외: 단독 목표 개선 후보 없음' }); continue; }
    const proposed = { ...accepted, ...stage.added }, ex = experiment(fixtureView, compact, proposed), c = metrics(fixtureView, ex);
    const kept = notWorse(c, previous);
    const checks = thresholds(b, c, Boolean(proposed.merge), fixture.metadata.directions, fixture.metadata.reciprocalPairs.length);
    combinations.push({ stage: stage.stage, options: proposed, metrics: c, thresholds: checks, status: kept ? '기하학 악화 없음; 라벨·전체 문턱 판정 보류' : '추가 전보다 악화하여 추가분 제외' });
    if (kept) { accepted = proposed; previous = c; }
  }
  combinations.push({ stage: '최종 기하학 후보에 채도 적용', status: '미실행: 전체 문턱을 통과한 최종 기하학 후보 없음' });
  results.push({ compact, baseline: b, candidates: rows, combinations, finalVerdict: '최종 통과 후보 없음: 확인된 문턱 실패 및 라벨·호스트 미검증' });
}
let variantChecks = 0;
const modes = [];
for (const compact of [false, true]) for (let state = 0; state < 5; state++) for (let dashed = 0; dashed < 4; dashed++)
  for (const labelMode of ['center', 'arrival']) for (const attributeMode of ['neutral', 'halves']) {
    const view = viewFor(state, dashed), ex = experiment(view, compact, { merge: true, labelMode, attributeMode });
    const m = metrics(view, ex), pair = ex.physical.find(p => p.directions.some(d => d.from === 'N8' && d.to === 'N9'));
    assert.equal(m.physicalPaths, fixture.metadata.directions - fixture.metadata.reciprocalPairs.length);
    assert.equal(m.missingInformation, 0); assert.equal(pair.directions.length, 2);
    assert.equal(ex.labels.filter(l => l.key === 'N8-N9' || l.key === 'N9-N8').length, 2);
    for (const mode of ['inferred', 'explicit:none', 'explicit:N8-N9', 'explicit:N9-N8']) {
      const directions = pair.directions.filter(d => mode === 'inferred' ? view.nodes.find(n => n.id === d.to).status === '실행 중' : mode === 'explicit:' + d.from + '-' + d.to).map(d => d.from + '→' + d.to);
      modes.push({ compact, state, dashed, labelMode, attributeMode, directionMode: mode, expectedAnimatedEnds: directions,
        dataPreservation: '통과', metrics: m, screenInterpretation: '미검증' }); variantChecks++;
    }
  }
const report = { measuredAt: new Date().toISOString(), fixture: fixture.metadata, baselineAudit,
  measurementScope: '호스트 없이 고정 배치 및 실제 선 조각 좌표에서 계산한 기하학. 실제 라벨 크기는 수집되지 않아 라벨 지표·라벨 포함 전체 경계는 null. 상태 scale 반영; rect 둥근 모서리는 16분할(오차 0.015px 이하). 정지 재계산 3회는 화면 재열기와 다름.',
  results, variantChecks, modes };
writeFileSync(resolve(fixturePath, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`fixture/baseline/geometry assertions passed; variant data checks=${variantChecks}; host measurements unavailable`);
