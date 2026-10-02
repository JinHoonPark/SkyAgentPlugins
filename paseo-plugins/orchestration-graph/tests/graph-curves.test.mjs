import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// 실제 패널 계산 코드를 빌드 산출물 없이 실행한다(Node 22.13 이상).
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const vendorUrl = moduleUrl(readFileSync(new URL("../client/vendor/dagre.js", import.meta.url), "utf8"));
const source = stripTypeScriptTypes(readFileSync(new URL("../client/motion-logic.ts", import.meta.url), "utf8"));
const motion = await import(moduleUrl(source.replace('"./vendor/dagre"', JSON.stringify(vendorUrl))));
const { layoutGraph, edgeLabelPlacements, incomingPaths, pointAlongSegments, edgeDashPieces } = motion;
const { default: dagre } = await import(vendorUrl);
const fixture = JSON.parse(readFileSync(new URL("../../spike-plugin/fixtures/graph-edge-layout/graph.json", import.meta.url), "utf8"));
const mainFlow = ["N1", "G1", "N3", "G3", "N4", "G4", "N5", "G5", "N6", "G6", "N7", "G7", "N8", "N9"];

const near = (actual, expected, epsilon = 1e-7) => assert(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const startOf = (segment) => ({ x: segment.left, y: segment.top + 1 });
const endOf = (segment) => ({
  x: segment.left + Math.cos(segment.deg * Math.PI / 180) * segment.width,
  y: segment.top + 1 + Math.sin(segment.deg * Math.PI / 180) * segment.width,
});
const nearPoint = (a, b) => { near(a.x, b.x); near(a.y, b.y); };
const centerY = (box) => box.top + box.height / 2;

function rawGraph(nodes, edges, compact) {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "TB", nodesep: compact ? 16 : 24, ranksep: compact ? 48 : 68 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    graph.setNode(node.id, { width: node.shape === "hexagon" ? 294 : 260, height: 42 + Math.max(1, node.labelLines.length) * 16 });
  }
  edges.forEach((edge, index) => {
    const feedback = edge.label?.startsWith("피드백");
    graph.setEdge(feedback ? edge.to : edge.from, feedback ? edge.from : edge.to, {}, String(index));
  });
  dagre.layout(graph);
  return graph;
}

// 독립적인 Bernstein 다항식으로 basis 곡선을 촘촘히 평가한다.
function referenceBasisSamples(points) {
  const samples = [points[0]];
  let start = { x: (5 * points[0].x + points[1].x) / 6, y: (5 * points[0].y + points[1].y) / 6 };
  samples.push(start);
  const extended = [...points, points.at(-1)];
  for (let i = 2; i < extended.length; i++) {
    const [a, b, c] = extended.slice(i - 2, i + 1);
    const control1 = { x: (2 * a.x + b.x) / 3, y: (2 * a.y + b.y) / 3 };
    const control2 = { x: (a.x + 2 * b.x) / 3, y: (a.y + 2 * b.y) / 3 };
    const end = { x: (a.x + 4 * b.x + c.x) / 6, y: (a.y + 4 * b.y + c.y) / 6 };
    for (let step = 1; step <= 80; step++) {
      const t = step / 80, u = 1 - t;
      const coordinate = (axis) => u ** 3 * start[axis] + 3 * u ** 2 * t * control1[axis] + 3 * u * t ** 2 * control2[axis] + t ** 3 * end[axis];
      samples.push({ x: coordinate("x"), y: coordinate("y") });
    }
    start = end;
  }
  samples.push(points.at(-1));
  return samples;
}

function distanceToSegment(point, segment) {
  const a = startOf(segment), b = endOf(segment);
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

for (const compact of [false, true]) {
  test(`샘플 ${compact ? "compact" : "일반"}: 본 흐름 rank·29개 경로·basis·끝 접선`, (t) => {
    const placed = layoutGraph(null, fixture.nodes, fixture.edges, compact);
    const graph = rawGraph(fixture.nodes, fixture.edges, compact);
    const ranks = mainFlow.map((id) => ({ id, rank: graph.node(id).rank }));
    for (let i = 1; i < mainFlow.length; i++) {
      assert(ranks[i - 1].rank < ranks[i].rank);
      assert(centerY(placed.boxes.get(mainFlow[i - 1])) < centerY(placed.boxes.get(mainFlow[i])));
    }
    assert.equal(placed.paths.length, 29);
    assert.equal(new Set(placed.paths.map((path) => path.key)).size, 29);
    assert.equal(new Set(placed.segments.map((segment) => segment.key)).size, placed.segments.length);
    fixture.edges.forEach((edge, index) => {
      const path = placed.paths[index];
      assert.deepEqual({ from: path.from, to: path.to, label: path.label, dashed: path.dashed }, edge);
      const feedback = edge.label?.startsWith("피드백");
      const raw = graph.edge(feedback ? edge.to : edge.from, feedback ? edge.from : edge.to, String(index)).points.slice();
      if (feedback) raw.reverse();
      const shiftX = placed.boxes.get(edge.from).left - Math.round(graph.node(edge.from).x - graph.node(edge.from).width / 2);
      const points = raw.map((point) => ({ x: point.x + shiftX, y: point.y + 16 }));
      assert(path.segments.length > raw.length - 1, "Dagre 꺾임점이 짧은 곡선 조각으로 분할됨");
      nearPoint(startOf(path.segments[0]), points[0]);
      nearPoint(endOf(path.segments.at(-1)), points.at(-1));
      const last = points.at(-1), previous = points.at(-2);
      near(path.segments.at(-1).deg, Math.atan2(last.y - previous.y, last.x - previous.x) * 180 / Math.PI);
      path.segments.forEach((segment, i) => {
        assert(segment.width > 0 && segment.width <= 16 + 1e-7);
        if (i > 0) nearPoint(endOf(path.segments[i - 1]), startOf(segment));
      });
      for (const point of referenceBasisSamples(points)) {
        assert(Math.min(...path.segments.map((segment) => distanceToSegment(point, segment))) <= 0.201, `${path.key}: basis 오차`);
      }
    });
    for (const [a, b] of fixture.metadata.reciprocalPairs) {
      const forward = placed.paths.find((path) => path.from === a && path.to === b);
      const reverse = placed.paths.find((path) => path.from === b && path.to === a);
      assert.notDeepEqual(pointAlongSegments(forward.segments, 0.5), pointAlongSegments(reverse.segments, 0.5));
    }
    assert(centerY(placed.boxes.get("N9")) > centerY(placed.boxes.get("N7")), "접두어 없는 순환은 원래 복귀 방향");
    t.diagnostic(`rank=${ranks.map(({ id, rank }) => `${id}:${rank}`).join("→")}; 조각=${placed.segments.length}`);
  });
}

test("곡선 위 라벨 배치·실행 중 진입 화살표는 원래 방향을 사용", () => {
  const edges = fixture.edges.map((edge) => ({ ...edge, dashed: true }));
  const placed = layoutGraph(null, fixture.nodes, edges, false);
  const labels = edgeLabelPlacements(placed.paths);
  assert.equal(labels.size, 29);
  for (const path of placed.paths) {
    assert.equal(path.dashed, true);
    const position = labels.get(path.key), middle = pointAlongSegments(path.segments, 0.5);
    near(position.y, middle.y);
    const reverse = placed.paths.find((other) => other.from === path.to && other.to === path.from);
    if (reverse == null) {
      assert.equal(position.align, "center");
      near(position.x, middle.x);
    } else {
      const reverseLabel = labels.get(reverse.key);
      assert.deepEqual(new Set([position.align, reverseLabel.align]), new Set(["start", "end"]));
      near(Math.abs(position.x - reverseLabel.x), 8);
    }
  }
  const incoming = incomingPaths(placed.paths, new Set(["N1"]));
  assert(incoming.some((path) => path.from === "G1" && path.to === "N1"));
  assert(!incoming.some((path) => path.from === "N1"));
  const feedback = incoming.find((path) => path.from === "G1");
  const early = pointAlongSegments(feedback.segments, 0.25), late = pointAlongSegments(feedback.segments, 0.75);
  assert(early.y > late.y);
  for (const path of placed.paths) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 0.999]) {
      const point = pointAlongSegments(path.segments, fraction);
      assert(Math.min(...path.segments.map((segment) => distanceToSegment(point, segment))) < 1e-7);
    }
  }
});

test("점선은 짧은 조각의 경계를 넘어 8px 선·6px 간격을 유지", () => {
  const placed = layoutGraph(null, fixture.nodes, fixture.edges, false);
  for (const path of placed.paths) {
    let offset = 0;
    for (const segment of path.segments) {
      const pieces = edgeDashPieces(segment.width, offset);
      for (let x = 0.125; x < segment.width; x += 0.25) {
        const painted = pieces.some((piece) => x >= piece.left && x < piece.left + piece.width);
        assert.equal(painted, (offset + x) % 14 < 8);
      }
      offset += segment.width;
    }
  }
});

test("root 연결도 곡선이고 원래 entryIds·방향을 유지", () => {
  const nodes = ["A", "B", "C"].map((id) => ({ id, labelLines: [id], shape: "rect" }));
  const edges = [{ from: "A", to: "B", dashed: true, label: "진행" }];
  const placed = layoutGraph({ id: "root" }, nodes, edges, false);
  assert.deepEqual(placed.entryIds, ["A", "C"]);
  assert.equal(placed.paths.length, 3);
  for (const id of placed.entryIds) {
    const path = placed.paths.find((path) => path.key === `root-${id}`);
    assert.equal(path.from, "root");
    assert.equal(path.to, id);
    assert.equal(path.label, null);
    assert.equal(path.dashed, false);
    assert(path.segments.length > 2);
    const first = startOf(path.segments[0]), last = endOf(path.segments.at(-1));
    near(first.y, placed.rootBox.top + placed.rootBox.height);
    near(last.y, placed.boxes.get(id).top);
  }
  assert.equal(layoutGraph(null, [], [], false).paths.length, 0);
});

test("실제 GraphCanvas 렌더: 조각·점선 위상·끝 화살촉·실행 중 화살표 연결", () => {
  const canvasSource = readFileSync(new URL("../client/graph-canvas.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(canvasSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  class Value {
    constructor(value) { this.value = value; }
    setValue(value) { this.value = value; }
    interpolate(config) { return { value: this, config }; }
  }
  const effects = [];
  let frame;
  const element = (type, props, key) => ({ type, props, key });
  const animation = () => ({ start() {}, stop() {} });
  const dependencies = {
    "react/jsx-runtime": { jsx: element, jsxs: element },
    react: {
      memo: (component) => component,
      useRef: (current) => ({ current }),
      useState: (initial) => [initial, () => {}],
      useMemo: (callback) => callback(),
      useEffect: (callback) => effects.push(callback),
    },
    "react-native": {
      View: "View", Text: "Text", Pressable: "Pressable",
      Animated: { Value, View: "AnimatedView", createAnimatedComponent: (component) => component, loop: animation, sequence: animation, timing: animation },
    },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon" },
    "./motion-logic": motion,
    "./cleanup": { registerStop: (stop) => stop },
  };
  const output = { exports: {} };
  runInNewContext(compiled, {
    module: output, exports: output.exports,
    require: (name) => { assert(name in dependencies, name); return dependencies[name]; },
    requestAnimationFrame: (callback) => { frame = callback; return 1; },
  });
  const view = { root: null, nodes: fixture.nodes, edges: fixture.edges.map((edge) => ({ ...edge, dashed: true })) };
  const placed = layoutGraph(null, view.nodes, view.edges, false);
  const colors = { accent: "accent", foregroundMuted: "muted", surface1: "surface" };
  const tree = output.exports.GraphCanvas({ view, placed, colors });
  const elements = [];
  function visit(node) {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node == null || typeof node !== "object") return;
    elements.push(node);
    visit(node.props?.children);
  }
  visit(tree);
  const pieces = elements.filter((node) => node.type?.name === "EdgeSegmentView");
  assert.equal(pieces.length, placed.segments.length);
  const byKey = new Map(pieces.map((piece) => [piece.key, piece]));
  for (const path of placed.paths) {
    let offset = 0;
    path.segments.forEach((segment, index) => {
      const piece = byKey.get(segment.key);
      near(piece.props.dashOffset, offset);
      near(piece.props.pos.width.value, segment.width);
      near(piece.props.pos.deg.value, segment.deg);
      assert.equal(piece.props.dashed, true);
      assert.equal(piece.props.head, index === path.segments.length - 1 && !view.nodes.some((node) => node.id === path.to && node.status === "실행 중"));
      const rendered = piece.type(piece.props);
      near(rendered.props.style.transform[0].rotate.value.value, segment.deg);
      assert.equal(rendered.props.style.transformOrigin, "0 50%");
      assert.equal(rendered.props.children[0].props.style.overflow, "hidden");
      if (piece.props.head) assert.equal(rendered.props.children[1].props.style.right, 0);
      offset += segment.width;
    });
  }
  const markers = elements.filter((node) => node.key?.startsWith("flow-"));
  const incoming = incomingPaths(placed.paths, new Set(view.nodes.filter((node) => node.status === "실행 중").map((node) => node.id)));
  assert.equal(markers.length, incoming.length);
  effects.at(-1)();
  frame(motion.FLOW_PERIOD_MS / 4);
  for (const path of incoming) {
    const marker = markers.find((node) => node.key === `flow-${path.key}`);
    const point = pointAlongSegments(path.segments, 0.25);
    const transforms = marker.props.style.transform;
    near(transforms[0].translateX.value + marker.props.style.width / 2, point.x);
    near(transforms[1].translateY.value + marker.props.style.height / 2, point.y);
    near(transforms[2].rotate.value.value, point.deg);
  }
});
test("레이아웃 전환: 조각 수가 바뀌어도 보간 중 고정 화살촉이 도착 경계에 연결", (t) => {
  const canvasSource = readFileSync(new URL("../client/graph-canvas.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(canvasSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const cases = [false, true].flatMap((reverse) => [false, true].map((feedback) => ({ reverse, feedback, branch: false })))
    .concat([false, true].map((reverse) => ({ reverse, feedback: false, branch: true })));
  for (const { reverse, feedback, branch } of cases) {
    const nodes = (branch ? ["A", "B", "C"] : ["A", "B"])
      .map((id) => ({ id, displayName: id, labelLines: [id], shape: "rect", status: "완료" }));
    const edges = branch ? ["A", "B"].map((from) => ({ from, to: "C", dashed: false, label: "진행" }))
      : [{ from: feedback ? "B" : "A", to: feedback ? "A" : "B", dashed: feedback, label: feedback ? "피드백: 재작업" : "진행" }];
    const view = { root: null, nodes, edges };
    const before = layoutGraph(null, nodes, edges, reverse), after = layoutGraph(null, nodes, edges, !reverse);
    assert.notEqual(before.segments.length, after.segments.length);
    if (branch) assert(before.paths.some((path, index) => Math.abs(path.segments.at(-1).deg - after.paths[index].segments.at(-1).deg) > 1e-7));
    const slots = [], effects = [], animations = new Map();
    let cursor = 0;
    class Value {
      constructor(value) { this.value = value; }
      setValue(value) { this.value = value; animations.delete(this); }
      interpolate(config) { return { value: this, config }; }
    }
    const element = (type, props, key) => ({ type, props, key });
    const dependencies = {
      "react/jsx-runtime": { jsx: element, jsxs: element },
      react: {
        memo: (component) => component,
        useRef: (current) => { const index = cursor++; return slots[index] ??= { current }; },
        useState: (initial) => {
          const index = cursor++;
          if (!(index in slots)) slots[index] = initial;
          return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
        },
        useMemo: (callback) => { cursor++; return callback(); },
        useEffect: (callback, deps) => { cursor++; effects.push({ callback, deps }); },
      },
      "react-native": {
        View: "View", Text: "Text", Pressable: "Pressable",
        Animated: {
          Value, View: "AnimatedView", createAnimatedComponent: (component) => component,
          timing: (value, config) => ({
            start() { animations.set(value, { from: value.value, to: config.toValue, duration: config.duration }); },
            stop() {},
          }),
          parallel: (children) => ({ start() { children.forEach((child) => child.start()); }, stop() {} }),
        },
      },
      "@getpaseo/plugin/client/react-native": { Icon: "Icon" },
      "./motion-logic": motion,
      "./cleanup": { registerStop: () => () => {} },
    };
    const output = { exports: {} };
    runInNewContext(compiled, {
      module: output, exports: output.exports,
      require: (name) => { assert(name in dependencies, name); return dependencies[name]; },
      setTimeout: () => 1, clearTimeout() {},
    });
    const render = (placed) => {
      cursor = 0; effects.length = 0;
      return output.exports.GraphCanvas({ view, placed, colors: { accent: "accent", foregroundMuted: "muted", surface1: "surface" } });
    };
    const runLayoutEffect = (placed) => effects.find((effect) => effect.deps?.length === 1 && effect.deps[0] === placed).callback();
    render(before); runLayoutEffect(before);
    let tree = render(after); runLayoutEffect(after);
    tree = render(after); // effect가 추가한 제거 조각도 다음 렌더에 포함한다.
    const elements = [];
    function visit(node) {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node == null || typeof node !== "object") return;
      elements.push(node); visit(node.props?.children);
    }
    visit(tree);
    const heads = elements.filter((node) => node.type?.name === "EdgeSegmentView" && node.props.head);
    assert.equal(heads.length, edges.length);
    let maximum = 0;
    for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      for (const [value, animation] of animations) {
        const fraction = Math.min(1, progress * motion.LAYOUT_MOVE_MS / animation.duration);
        value.value = animation.from + (animation.to - animation.from) * fraction;
      }
      for (const path of after.paths) {
        const head = heads.find((node) => node.key === path.segments.at(-1).key);
        const rendered = head.type(head.props);
        const style = rendered.props.style;
        const width = typeof style.width === "number" ? style.width : style.width.value;
        const angle = style.transform[0].rotate.value.value * Math.PI / 180;
        const tip = { x: style.left.value + Math.cos(angle) * width, y: style.top.value + 1 + Math.sin(angle) * width };
        const node = elements.find((element) => element.type?.name === "NodeBoxView" && element.key === path.to);
        const box = after.boxes.get(path.to), pos = node.props.pos;
        const left = pos.tx.value, top = pos.ty.value;
        const clampX = Math.max(left, Math.min(left + box.width, tip.x));
        const clampY = Math.max(top, Math.min(top + box.height, tip.y));
        const gap = Math.min(
          Math.hypot(tip.x - clampX, tip.y - top),
          Math.hypot(tip.x - clampX, tip.y - top - box.height),
          Math.hypot(tip.x - left, tip.y - clampY),
          Math.hypot(tip.x - left - box.width, tip.y - clampY),
        );
        maximum = Math.max(maximum, gap);
      }
    }
    t.diagnostic(`${branch ? "접선 각도가 바뀌는 분기" : feedback ? "피드백" : "본 흐름"} ${reverse ? "compact→일반" : "일반→compact"}: ${before.segments.length}→${after.segments.length}조각; 최대 화살촉 경계 간격=${maximum.toFixed(8)}px`);
    assert(maximum < 1e-7, `고정 화살촉이 도착 경계에서 ${maximum}px 떨어짐`);
  }
});
