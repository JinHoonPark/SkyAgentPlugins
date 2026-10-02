import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const fixtureDir = resolve(import.meta.dirname, '../fixtures/graph-edge-layout');
const data = JSON.parse(readFileSync(resolve(fixtureDir, 'measurements.json'), 'utf8'));
const host = JSON.parse(readFileSync(resolve(fixtureDir, 'host-observation.json'), 'utf8'));
const installedPath = host.entries[0].path;
const target = resolve(root, '.skywork/paseo-orchestration/2026-10-01-graph-edge-spike/nodes');
mkdirSync(target, { recursive: true });
const plugin = resolve(import.meta.dirname, '..');
const fmt = n => n == null ? '해당 없음' : Number(n).toFixed(2);
const verdict = value => value == null ? '미검증' : value === true ? '통과' : '미통과';
const names = { crossings: '교차', penetration: '노드 관통', ports: '접점', labelDistance: '라벨 거리', labelOwnership: '라벨 소속·가림', labelOverlap: '라벨 겹침',
  bounds: '라벨 포함 크기', bundles: '외곽 다발·중첩', paths: '경로 수·길이·꺾임', informationData: '원본 정보 데이터', informationScreen: '화면 정보 복원', stabilityScreen: '화면 안정성' };
const lines = [
  '# 연결선 정돈 스파이크 실행 결과', '',
  '## 결론', '',
  '시제품 구현·typecheck·고정 입력 감사·호스트 없이 가능한 정량 측정은 완료했다. 왕복 한 선은 일반·compact 모두 29개 방향을 그대로 보존하면서 물리 경로를 24개로 줄였다. 모든 후보가 확인된 기하학 문턱 중 하나 이상에서 실패하므로 최종 통과 후보는 없다. 이 결과는 단독 후보의 부분 효과와 최종 결합 통과를 구분한다.', '',
  '호스트 설치 소스가 다른 저장소이므로 reload를 실행하지 않았다. 실제 라벨 크기·호스트 표시·애니메이션·사용자 판단이 필요한 항목은 미검증이다. 실제 화면을 확인하지 않았으므로 시제품 화면의 실행 성공이나 전체 합격을 선언하지 않는다.', '',
  '## 수행 범위와 실행 증빙', '',
  '- 수정 범위: `paseo-plugins/spike-plugin/`와 이 결과·실패 보고 파일. 원본 워크트리와 `orchestration-graph`는 읽기만 했다.',
  '- `node paseo-plugins/spike-plugin/scripts/snapshot-graph.mjs <설계의 원본 GRAPH.md 경로>`: 종료 0. 원본 바이트 버퍼를 한 번 읽어 복사한 뒤 복사본 바이트 일치, SHA-256, 현재 파서로 선언 대조를 통과했다. 이후 측정은 복사본만 사용했다.',
  '- `node paseo-plugins/spike-plugin/scripts/measure-graph.mjs`: 종료 0. `fixture/baseline/geometry assertions passed; variant data checks=640; host measurements unavailable`.',
  '- `npm --prefix paseo-plugins/spike-plugin run typecheck`: 종료 0. `tsc --noEmit` 오류 없음.',
  '- `git diff --check`: 종료 0. 공백 오류 없음. Git의 LF→CRLF 안내만 출력됐다.',
  '- `package.json`에 build 스크립트가 없어 build 명령은 해당 없음. 측정 스크립트는 TypeScript의 타입을 제거해 실제 배치·측정 코드를 Node에서 실행했다.',
  '- 의존성: 최초 오프라인 설치는 캐시에 없는 최신 Node 타입으로 실패했다. lockfile의 캐시된 버전으로 `npm --prefix paseo-plugins/spike-plugin install --offline --ignore-scripts --package-lock=false --save=false @types/node@22.20.3`을 실행해 종료 0으로 복구했다. 매니페스트·lockfile·버전 변경 없음.',
  '- 정지 좌표 계산은 후보별 3회 일치했다. 이 확인은 화면을 다시 연 3회 검증이나 실제 애니메이션 안정성 검증을 대체하지 않는다.', '',
  '## 고정 입력', '',
  `- 복사 시각: ${data.fixture.copiedAt}`, `- 복사본 SHA-256: \`${data.fixture.sha256}\``,
  `- 집계: 표 ${data.fixture.tableRows}행, 노드 ${data.fixture.nodes}개, 방향 ${data.fixture.directions}개, 왕복 ${data.fixture.reciprocalPairs.length}쌍, 육각형 ${data.fixture.hexagons}개, 점선 ${data.fixture.dashed}개.`,
  '- 왕복: ' + data.fixture.reciprocalPairs.map(p => p.join('↔')).join(', ') + '.',
  '- 원본 `GRAPH.md`는 그대로 보존했다. 런타임 `graph.json`·`graph.ts`에는 agentId가 없으며 실제 에이전트를 조회하지 않는다. 원본 상태·labelLines·shape·방향·라벨·dashed를 보존했다. 루트 요약 카드 없음.',
  '- 현재 파서의 함수·보조 함수를 메모리 변환하여 실행했다. 모든 노드 선언·방향·라벨·도형·속성을 대조했고 Mermaid frontmatter가 노드로 들어가지 않았다.',
  '- 입력 감사 구현: `paseo-plugins/spike-plugin/scripts/snapshot-graph.mjs:10` (parserSource — 현재 서버 파서와 보조 함수 추출), 같은 파일 `:15` (bytes — 원본의 단 한 번 읽기), 같은 파일 `:53` (fixture — agentId를 제외한 렌더 입력 고정).', '',
  '## 기준 구현과 측정 한계', '',
  '- `motion-logic.ts`는 타입 import 경로를 제외하면 현재 제품 소스 전체와 일치한다. Dagre 번들은 바이트 동일하다. 카드·육각형·점선·선·화살촉 구현은 함수 단위로 원문 대조했다. 라벨 실측 콜백·누름 툴팁과 후보 overlay를 추가했지만, 개선 전은 원래 배치·접점·라벨 위치·카드 크기·레이어·상태 연출을 사용한다.',
  '- 기준 감사: `paseo-plugins/spike-plugin/scripts/measure-graph.mjs:17` (assert — 배치 원문 일치), 같은 파일 `:18` (assert — Dagre 바이트 일치), 같은 파일 `:22` (함수 대조 루프 — 카드·선·화살촉 원문 일치). 호스트에서의 동등성은 미검증이다.',
  '- 선 교차·관통·길이·꺾임은 View에 전달하는 실제 반올림 선 조각 좌표로 계산했다. 공통 노드의 정상 접점은 제외하고 1px 이내 중복 교점을 합쳤다. 정상 접점 이후 자기 노드 내부를 통과한 오류도 관통에 포함한다.',
  '- 카드 윤곽은 원래 상태 scale을 반영했다. 육각형은 실제 6각 다각형, 둥근 직사각형은 모서리당 16분할로 계산했다(기하학 근사 오차 0.015px 이하). 실행 중·완료 카드의 확대 때문에 개선 전에도 자기 끝점 노드 관통이 계수된다. 이 관통은 노드·관계 쌍으로 집계하며 별도 상세 배열에 남겼다.',
  '- `paseo-plugins/spike-plugin/client/spikes/graph-edge/experiment.ts:65` (nodeContour — 상태 확대와 실제 카드 윤곽), `paseo-plugins/spike-plugin/client/spikes/graph-edge/metrics.ts:16` (metrics — 교차·관통·접점·외곽 다발·경로 집계), 같은 파일 `:107` (thresholds — 설계 문턱 판정).',
  '- 아래 폭·높이·면적은 **실측 라벨을 포함하지 않은 기하학 경계**다. 원래 상태의 카드와 전체 선·화살촉을 포함한다. 라벨 포함 최종 크기 문턱은 판정하지 않았다. 라벨 추정 크기를 실측값으로 사용하지 않았다.',
  '- 라벨 회피 8/16px 및 Dagre 실측 라벨 예약은 구현됐지만 실제 측정 크기가 없으므로 라벨 효과는 실행·판정하지 않았다. 해당 후보의 표에는 라벨 요인이 적용되기 전의 고정 경로 수치만 기록했다.', '',
];
for (const result of data.results) {
  const b = result.baseline;
  lines.push(`## ${result.compact ? 'compact' : '일반'}: 개선 전과 단독 후보`, '',
    `개선 전 교차 B=${b.crossings}이므로 교차 문턱은 floor(0.7×B)=${Math.floor(0.7 * b.crossings)}이다. 노드 관통 0, 접점 최소 12px 및 개선 전 이상, 길이 ≤${fmt(b.totalLength * 1.2)}px, 관계당 최대 꺾임 ≤${b.maxBends + 2}를 적용했다.`, '',
    '| 후보 | 교차 | 관통 쌍 | 접점 최소 px | 윤곽 미접점 | 물리/논리 | 총 길이 px (C/B) | 최대/총 꺾임 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of result.candidates) {
    const c = r.metrics;
    lines.push(`| ${r.title} | ${c.crossings} | ${c.penetratingPairs} | ${fmt(c.minPortDistance)} | ${c.invalidEndpoints} | ${c.physicalPaths}/${c.logicalDirections} | ${fmt(c.totalLength)} (${fmt(c.totalLength / b.totalLength)}) | ${c.maxBends}/${c.totalBends} |`);
  }
  lines.push('', '다른 모습의 혼잡: 외곽 다발·밀집 구간·완전 중첩·크기 증가를 전체 경로에서 계산했다.', '',
    '| 후보 | 좌/우 레인 | 레인 최소 px | 밀집 구간 쌍 | 완전 중첩 px | 기하학 폭×높이 px | 폭/높이/면적 C/B |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const r of result.candidates) {
    const c = r.metrics;
    lines.push(`| ${r.title} | ${c.lanesLeft}/${c.lanesRight} | ${fmt(c.minLaneDistance)} | ${c.densePairs} | ${fmt(c.overlapLength)} | ${fmt(c.width)}×${fmt(c.height)} | ${fmt(c.width / b.width)}/${fmt(c.height / b.height)}/${fmt(c.area / b.area)} |`);
  }
  lines.push('', '문턱별 판정. 데이터 정보 통과는 원본 정보가 시제품 입력에 보존됐다는 뜻이며 화면 복원 통과와 다르다.', '',
    '| 후보 | 교차 | 관통 | 접점 | 라벨 거리 | 라벨 소속·가림 | 라벨 겹침 | 크기 | 다발·중첩 | 경로 | 정보 데이터 | 화면 정보·안정 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of result.candidates) {
    const c = r.thresholds;
    lines.push(`| ${r.title} | ${['crossings','penetration','ports','labelDistance','labelOwnership','labelOverlap','bounds','bundles','paths','informationData'].map(key => verdict(c[key])).join(' | ')} | 미검증 |`);
  }
  lines.push('', '### 정해진 순서의 결합 판정', '');
  for (const combination of result.combinations) lines.push('- ' + combination.stage + ': ' + combination.status + (combination.metrics ? ` (교차 ${combination.metrics.crossings}, 관통 ${combination.metrics.penetratingPairs}, 길이 ${fmt(combination.metrics.totalLength)}px, 최대 꺾임 ${combination.metrics.maxBends})` : '') + '.');
  lines.push('', '왕복 한 선+접점 분산을 추가하면 교차·길이가 악화하여 해당 추가분을 제외했다. 외곽 레인 추가도 교차·길이 악화로 제외했다. 직교화는 관통을 0으로 만들지만 교차 8과 최대 꺾임 6으로 악화하여 제외했다. 라벨 추가는 실측이 없어서 판정하지 않았다. 최종 기하학 통과 후보가 없어 마지막 채도 결합은 실행하지 않았다. 전체 최종 판정: 통과 후보 없음.', '');
}
lines.push('## 가설 판정과 왕복 미확정 모드', '',
  '- 복귀 외곽 12/20px: 레인 간격 자체는 12/20px를 확보하지만 출입부 교차와 전체 길이가 크게 늘었다. 명시 종류로 재배치한 경우도 최종 교차·관통 문턱을 통과하지 못했다. 외곽 다발로 보이는지의 사용자 판정은 미검증이다.',
  '- 왕복 한 선: 물리 24개·논리 방향 29개·원본 누락 0개 통과. 총 길이는 일반 6194/7114=0.87배, compact 5326/6100=0.87배다. 교차가 1개로 남아 최종 교차 문턱 0을 통과하지 못한다. 두 라벨의 실제 소속·겹침·속성 독해는 미검증이다.',
  '- 접점 분산 12/16px 및 왕복과의 결합: 접점을 실제 윤곽으로 분산했으나 기존 구간을 유지하는 단독 방식은 교차·관통·경로 길이에서 최종 문턱을 충족하지 못했다. 마지막 구간의 자기 노드 관통도 상세 배열에 포함된다.',
  '- 라벨 회피 8/16px·실측 예약: 구현 완료, 효과 미검증. 실제 호스트 측정 라벨 사각형이 없어 라벨-노드·라벨-라벨 교차, 소속 거리 최대·95백분위, 다른 선 가림·소속 불명 수를 임의 수치로 보고하지 않았다.',
  '- 시각적 우선순위: 같은 선 좌표·교차·관통·길이를 유지한다는 코드 실행 확인 통과. 기하학 개선이 아니며 다크·라이트 식별과 hover·누름 강조의 실행 확인은 미검증이다.',
  '- 간격 1.25배: 교차 1개 유지, 기하학 크기 증가. 최종 개선으로 판정하지 않는다.',
  '- 장애물 회피 직교화: 일반·compact 노드 관통 0 통과. 교차 1→8, 최대 꺾임 2→6으로 교차·꺾임 문턱 실패. 단순 L자 변환 대신 노드 경계 가시성 격자에서 경로를 구했다.',
  `- 왕복 변형 ${data.variantChecks}개 데이터 검사: 일반/compact × 상태 5종 × 점선 4종 × 중앙/도착점 라벨 × 중립/절반 속성 × 상태 추정/자동 없음/정방향 선택/역방향 선택. 모든 검사에서 24물리·29논리·두 라벨·방향별 dashed 보존 확인. 화면 애니메이션 및 사용자의 이해는 미검증이다.`,
  '- 두 방향의 원본 데이터를 삭제하지 않고 하나의 물리 경로에서 중앙 양쪽/도착점 근처 라벨, 양끝 고정 화살표, 도착점 화살표의 독립 연출을 구현했다. 몸통을 이동시키거나 두 번째 관계선을 그리지 않는다.',
  '- 상태 추정의 N8만 실행은 N9→N8 도착점 연출, N9만 실행은 N8→N9 연출, 양쪽 실행은 양끝 독립 연출, 양쪽 대기·완료는 정지다. 명시 선택 모드는 자동 연출 없음과 각 방향 선택을 제공한다.',
  '- 종류 필드의 feedback은 설계의 7방향만 지정했고, 기하학 분류와 다른 모든 방향을 좌표·지표 표시에서 공개했다. forward 순환은 현행 Dagre가 처리한다. 제품 규칙이나 원본 스키마를 확정·변경하지 않았다.',
  '- 시제품 후보 구현: `paseo-plugins/spike-plugin/client/spikes/graph-edge/experiment.ts:15` (CANDIDATES — 정해진 단독 후보·두 튜닝값), 같은 파일 `:33` (feedback — 설계의 명시 종류 7방향), `paseo-plugins/spike-plugin/client/spikes/graph-edge/candidate-layer.tsx:47` (CandidateLayer — 한 몸통·양끝 고정 화살표·방향별 라벨·점선 속성).', '',
  '## 호스트 반영과 사용자 화면 열기', '',
  `- \`paseo plugin ls spike-plugin --json\`: 종료 ${host.listExitCode}. enabled=true, status=running이지만 설치 path는 \`${installedPath}\`이었다. 현재 워크스페이스의 새 시제품을 로드한 상태가 아니다. 조회 시각과 원시 JSON·로그는 fixture의 host-observation.json에 있다.`,
  '- `paseo plugin logs spike-plugin`: 종료 0. 기존 설치본의 Loading plugin/Plugin ready 기록만 확인했다. 새 시제품 컴파일·등록의 증거로 사용하지 않는다.',
  '- reload: **미실행**. 다른 소스의 플러그인 reload는 허용되지 않았고, 현재 워크스페이스 설치 변경 승인이 없다. 데몬 재시작·종료·활성화·비활성화는 하지 않았다.',
  '- 필요한 정확한 명령(실행하지 않음):', '',
  '```powershell', `paseo plugin install "${plugin}"`, '```', '',
  '이 명령은 설치 소스를 현재 워크스페이스로 바꾸는 저장소 밖 설정 변경이므로 별도 승인이 필요하다. 설치가 승인·수행된 후에는 이 소스임을 `paseo plugin ls spike-plugin --json`으로 확인하고 허용된 `paseo plugin reload spike-plugin` 및 `paseo plugin logs spike-plugin`으로 새 코드 반영을 검증할 수 있다.', '',
  '- 화면 경로: 에이전트 입력창의 `Spike` 버튼 → `시각 스파이크 확인` 패널 → `샘플 그래프 연결선 정돈 전후 비교` 행의 `보기`. 요청 전송 버튼은 누를 필요가 없다. 기존 패널 등록은 `paseo-plugins/spike-plugin/index.client.tsx:17` (addWorkspacePanel — 패널 등록), 새 항목은 `paseo-plugins/spike-plugin/client/spikes/index.ts:16` (SPIKE_PROTOTYPES 항목 — 비교 화면 등록)이다.',
  '- 후보 전환: 화면 위의 후보 버튼. `왕복 한 선`, `접점 분산 12/16px`, `한 선·접점 분산 12/16px`, 외곽/종류 12/20px, 라벨 회피 8/16px, 실측 예약, 채도, 간격, 직교를 선택한다.',
  '- 보기 조작: `전체 보기`는 두 화면을 포함하는 공통 배율, `원래 크기 100%`는 확대 없는 비교. 두 영역은 동일 뷰포트 크기이며 좁은 화면에서는 `전 화면/후 화면`으로 전환한다. 드래그 팬을 동기화하고 N3/G3/N10/N11, G4/N1, G1/N5, N8/N9/N7 이동 버튼을 제공한다.',
  '- `좌표·지표`는 개선 전·선택 후보의 노드·선·라벨 좌표, 현재 수치·문턱·종류 분류 차이를 표시한다. fixture 해시·복사 시각·compact·뷰포트·배율은 항상 표시한다. `정지 화면 다시 열기·7초 측정`을 동일 후보에서 3회 누르면 2초 후의 좌표를 5초 동안 관찰하여 변동 여부와 재열기 좌표 일치를 표시한다. 실제 화면 실험은 아직 실행하지 않았다.',
  '- 사용자 확인: 다크 테마에서 후보명을 가리고 전체/확대 비교한다. G3↔N3·N8↔N9의 두 방향과 두 라벨, G4→N1·G1→N5·N9→N7의 출발/도착을 설명한다. N8/N9 상태 5종·합성 점선 4종, 라벨 중앙/도착점, 중립/절반 속성, 상태 추정/명시 방향을 비교하고 잘린 문구는 hover 또는 누름 툴팁으로 복원한다. 시각적 우선순위는 라이트 테마에서도 확인한다.',
  '- 사용자 평점: 전체 정돈감·접점 밀집·외곽 다발·라벨 소속·긴 경로 추적을 전후 각각 1~5점으로 평가한다. 전체 +1점 이상, 나머지 하락 없음이 필요하다. 현재 정량 통과 후보가 없으므로 가장 가까운 `왕복 한 선` 화면을 보여 주되 합격으로 표시하지 않는다. 미확정 라벨·진행·점선 병합·feedback 판별 안의 사용자 선택도 남아 있다.',
  '- 화면 조작 구현: `paseo-plugins/spike-plugin/client/spikes/graph-edge/screen.tsx:9` (GraphEdgeSpike — 동일 뷰포트·후보/상태/속성 전환·좌표 표시).', '',
  '## 미검증·미실행', '',
  '- 실제 호스트 새 시제품 로드·기준 화면 동등성·wide/compact·다크/라이트 화면: 설치 소스 불일치 및 설치 권한 없음.',
  '- 실측 라벨 거리 최대/95백분위·소속 불명·다른 선 가림·라벨-노드/라벨-라벨 겹침·라벨 포함 전체 폭/높이/면적: 호스트 onLayout 측정 없음. JSON의 해당 값·문턱은 null이며 모든 후보에서 미검증이다.',
  '- 후보별 화면 3회 재열기, 2초 내 안정 및 이후 5초 ≤1px, 전환 중 교차·소속 오류·연출 누락: 실제 호스트 없음. 정적 계산 3회 일치만 확인했다.',
  '- 사용자 정보 독해·정돈감 평점·미확정 모드 선택: 사용자가 판단해야 하며 워커는 대신 판정하지 않았다.',
  '- 결합 라벨 단계와 최종 기하학 후보의 채도 추가: 앞서 설명한 라벨 미측정 및 통과 후보 부재로 실행하지 않았다.',
  '- 원문 스펙·스파이크 목록·마일스톤은 변경하지 않았다. 실패 보고는 같은 디렉터리의 `N2.failure.md`다.', '',
  '## 원시 측정값과 재현', '',
  '- `paseo-plugins/spike-plugin/fixtures/graph-edge-layout/measurements.json`: 모든 후보·문턱, 관통/미접점 상세, 정지 좌표, 640개 왕복 데이터 변형의 속성·예상 화살표 연출·측정값을 담는다.',
  '- 고정 입력을 다시 복사하지 않고 아래 명령을 실행하면 같은 fixture 해시로 기하학 값을 다시 계산한다. 원본 스냅샷 준비 명령은 기존 입력을 새 시점으로 덮어쓰므로 이번 결과 재현에는 실행하지 않는다.', '',
  '```powershell', 'node paseo-plugins/spike-plugin/scripts/measure-graph.mjs', 'npm --prefix paseo-plugins/spike-plugin run typecheck', 'node paseo-plugins/spike-plugin/scripts/report-graph.mjs', '```', '',
);
writeFileSync(resolve(target, 'N2.md'), lines.join('\n'));
writeFileSync(resolve(target, 'N2.failure.md'), [
  '# 호스트 검증 중단 보고', '',
  '실패 범위: 호스트 반영 및 실제 화면 검증만. 시제품 구현·typecheck·고정 입력 검증·호스트 없이 계산 가능한 측정은 완료했다.', '',
  `\`paseo plugin ls spike-plugin --json\` 종료 ${host.listExitCode}의 설치 소스는 \`${installedPath}\`이며 현재 워크스페이스와 다르다. 현재 코드가 설치되지 않아 새 fixture 해시·후보를 호스트에서 확인할 수 없다.`, '',
  '설치 소스 변경은 승인되지 않은 저장소 밖 설정 변경이다. 따라서 install 및 다른 소스에 대한 reload를 실행하지 않았다. 필요한 정확한 명령은 다음과 같다.', '',
  '```powershell', `paseo plugin install "${plugin}"`, '```', '',
  '이 명령은 실행하지 않았다. 데몬 재시작·종료가 필요하다는 가정으로 우회하지 않았다.', '',
  '미검증: 호스트 기준 구현 동등성, 실측 라벨 및 라벨 포함 크기, 호스트 컴파일·등록·새 코드 로드, wide/compact·다크/라이트 표시, 3회 화면 재열기 및 애니메이션 안정성, 사용자 정보 독해·평점·미확정 규칙 선택.', '',
  '후보별 기하학 문턱 미통과는 실험 결과이며 구현 작업 실패와 구분했다. 세부 결과·실행 증빙·열기 방법은 N2.md와 fixture의 measurements.json에 있다.', '',
].join('\n'));
console.log('N2.md / N2.failure.md 작성 완료');
