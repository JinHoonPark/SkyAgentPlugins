import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = stripTypeScriptTypes(readFileSync(new URL("../client/zoom-logic.ts", import.meta.url), "utf8"));
const zoomLogic = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const { canvasToViewport, DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM, panBounds, zoomAtCursor } = zoomLogic;
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const canvas = { width: 1800, height: 2400 };
const viewport = { width: 800, height: 600 };

test("휠 위는 확대, 아래는 축소하며 기본 배율과 25%~200% 제한을 지킨다", () => {
  assert.equal(DEFAULT_ZOOM, 1);
  assert.equal(MIN_ZOOM, 0.25);
  assert.equal(MAX_ZOOM, 2);
  const zoom = (scale, delta) => zoomAtCursor({ x: 0, y: 0 }, scale, delta, { x: 0, y: 0 }, canvas, viewport);
  assert(zoom(1, -100).scale > 1);
  assert(zoom(1, 100).scale < 1);
  assert.equal(zoom(1, 0).scale, 1);
  assert.equal(zoom(1, -10000).scale, 2);
  assert.equal(zoom(1, 10000).scale, 0.25);
  assert.deepEqual(zoom(2, -100).camera, { x: 0, y: 0 });
  assert.deepEqual(zoom(0.25, 100).camera, { x: 0, y: 0 });
});

test("기존 팬과 배율이 있어도 커서 아래 캔버스 지점이 줌 전후 같은 화면 위치를 유지", () => {
  for (const scale of [0.25, 0.5, 1, 1.7, 2]) {
    for (const delta of [-200, 200, -10000, 10000]) {
      const camera = { x: -120, y: -80 };
      const cursor = { x: 260, y: 190 };
      const point = { x: (cursor.x - camera.x) / scale, y: (cursor.y - camera.y) / scale };
      const next = zoomAtCursor(camera, scale, delta, cursor, canvas, viewport);
      const screen = canvasToViewport(point, next.camera, next.scale);
      near(screen.x, cursor.x);
      near(screen.y, cursor.y);
    }
  }
});

test("팬 경계는 확대·축소된 캔버스 크기와 화면 픽셀 기준 노출 폭으로 계산", () => {
  assert.deepEqual(panBounds(1800, 2400, 800, 600, 2), { minX: -3536, maxX: 736, minY: -4736, maxY: 536 });
  assert.deepEqual(panBounds(1800, 2400, 800, 600, 0.25), { minX: -386, maxX: 736, minY: -536, maxY: 536 });
  assert.deepEqual(panBounds(100, 80, 800, 600, 0.25), { minX: 0, maxX: 775, minY: 0, maxY: 580 });
  assert.deepEqual(panBounds(100, 80, 0, 0, 1), { minX: -100, maxX: 0, minY: -80, maxY: 0 });
});

test("줌의 커서 보정이 팬 경계를 넘으면 다음 배율의 경계에서 멈춘다", () => {
  const next = zoomAtCursor({ x: -1736, y: -2336 }, 1, 10000, { x: 0, y: 0 }, canvas, viewport);
  assert.equal(next.scale, 0.25);
  assert.equal(next.camera.x, next.bounds.minX);
  assert.equal(next.camera.y, next.bounds.minY);
  const upper = zoomAtCursor({ x: 736, y: 536 }, 1, -10000, { x: 0, y: 0 }, canvas, viewport);
  assert.equal(upper.camera.x, upper.bounds.maxX);
  assert.equal(upper.camera.y, upper.bounds.maxY);
});

test("툴팁의 라벨 중심·하단 좌표에 배율과 카메라 이동을 적용", () => {
  const label = { left: 100, top: 60, width: 80, height: 28 };
  for (const scale of [0.25, 1, 2]) {
    const anchor = canvasToViewport({ x: label.left + label.width / 2, y: label.top + label.height }, { x: -30, y: 15 }, scale);
    near(anchor.x, -30 + 140 * scale);
    near(anchor.y, 15 + 88 * scale);
  }
});

function webModule(os) {
  const compiled = ts.transpileModule(readFileSync(new URL("../client/web.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const output = { exports: {} };
  runInNewContext(compiled, {
    module: output, exports: output.exports,
    require: (name) => { assert.equal(name, "react-native"); return { Platform: { OS: os } }; },
  });
  return output.exports;
}

test("웹 뷰포트는 스크롤을 차단하고 실제 화면 원점 기준 커서·휠 단위를 전달하며 연결을 해제", () => {
  let listener;
  const target = {
    getBoundingClientRect: () => ({ left: 120, top: 200, height: 600 }),
    addEventListener: (type, callback, options) => {
      assert.equal(type, "wheel");
      assert.equal(options.passive, false);
      assert.equal(options.capture, true);
      listener = callback;
    },
    removeEventListener: (type, callback, capture) => {
      assert.equal(type, "wheel"); assert.equal(callback, listener); assert.equal(capture, true);
      listener = null;
    },
  };
  const received = [];
  const stop = webModule("web").listenGraphWheel(target, (delta, cursor) => received.push({ delta, cursor }));
  for (const [deltaMode, expected] of [[0, -2], [1, -32], [2, -1200]]) {
    let prevented = false, stopped = false;
    listener({ clientX: 350, clientY: 470, deltaY: -2, deltaMode,
      preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    assert(prevented && stopped);
    assert.equal(received.at(-1).delta, expected);
    assert.equal(received.at(-1).cursor.x, 230);
    assert.equal(received.at(-1).cursor.y, 270);
  }
  stop();
  assert.equal(listener, null);
});

test("모바일에서는 DOM이나 휠 대상에 접근하지 않는다", () => {
  for (const os of ["ios", "android"]) {
    const target = new Proxy({}, { get() { assert.fail("네이티브에서 웹 대상 접근"); } });
    webModule(os).listenGraphWheel(target, () => assert.fail("네이티브 휠 호출"))();
  }
  webModule("web").listenGraphWheel(null, () => assert.fail("없는 대상 휠 호출"))();
});

test("실제 패널 연결: 연속 휠·배율 변환·팬·노드 클릭·툴팁·그래프 전환 초기화", () => {
  const compiled = ts.transpileModule(readFileSync(new URL("../client/panel.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const slots = [], effects = [];
  let cursor = 0, wheel, graphName = "first";
  const sameDeps = (before, after) => before != null && after != null &&
    before.length === after.length && before.every((value, index) => Object.is(value, after[index]));
  const useMemo = (callback, deps) => {
    const index = cursor++;
    if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { deps, value: callback() };
    return slots[index].value;
  };
  const react = {
    useRef: (current) => { const index = cursor++; return slots[index] ??= { current }; },
    useState: (initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useMemo, useCallback: (callback, deps) => useMemo(() => callback, deps),
    useEffect: (callback, deps) => {
      const index = cursor++;
      if (!sameDeps(slots[index]?.deps, deps)) effects.push(() => {
        slots[index]?.stop?.(); slots[index] = { deps, stop: callback() };
      });
    },
  };
  class ValueXY {
    constructor(value) { this.setValue(value); }
    setValue(value) { this.x = value.x; this.y = value.y; }
  }
  const element = (type, props, key) => ({ type, props, key });
  const rpcNames = ["findGraphByAgentRpc", "getGraphRpc", "readGraphFileRpc", "retryGraphSummaryRpc"];
  const shared = Object.fromEntries(rpcNames.map((name) => [name, { name }]));
  const rpcs = Object.fromEntries(rpcNames.map((name) => [name, () => Promise.resolve(null)]));
  const paseo = { agents: { subscribe: () => () => {} } };
  const placed = { canvasWidth: canvas.width, canvasHeight: canvas.height };
  const target = {};
  const opened = [];
  const dependencies = {
    "react/jsx-runtime": { jsx: element, jsxs: element },
    react,
    "react-native": {
      View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView",
      ActivityIndicator: "ActivityIndicator", Animated: { ValueXY, View: "AnimatedView" },
      PanResponder: { create: (handlers) => ({ panHandlers: handlers }) },
    },
    "@getpaseo/plugin/client": {
      useWorkspace: () => "directory", usePaseo: () => paseo, useRpc: (rpc) => rpcs[rpc.name],
    },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon" },
    "@tanstack/react-query": { useQuery: ({ queryKey }) => queryKey[0] === "findGraphByAgentRpc"
      ? { isSuccess: true, data: { items: [{ name: graphName }] } }
      : { data: { name: graphName, root: null, nodes: [], edges: [], waiting: false } } },
    "../shared/graphs": { ...shared, layoutSignature: () => graphName },
    "./cleanup": { registerStop: (stop) => stop },
    "./graph-canvas": { GraphCanvas: "GraphCanvas" },
    "./live-graph": { applyLiveGraph: (view) => view },
    "./motion-logic": { layoutGraph: () => placed },
    "./zoom-logic": zoomLogic,
    "./web": { listenGraphWheel: (view, callback) => {
      assert.equal(view, target); wheel = callback; return () => { wheel = null; };
    } },
  };
  const output = { exports: {} };
  runInNewContext(compiled, {
    module: output, exports: output.exports,
    require: (name) => { assert(name in dependencies, name); return dependencies[name]; },
    setInterval: () => 1, clearInterval() {},
  });
  const props = {
    theme: { colors: {} }, layout: { compact: false }, workspaceId: "workspace", agentId: "agent",
    navigation: { openAgent: (agent) => opened.push(agent.agentId) },
  };
  const allElements = (tree) => {
    const elements = [];
    const visit = (node) => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node == null || typeof node !== "object") return;
      elements.push(node); visit(node.props?.children);
    };
    visit(tree); return elements;
  };
  const render = () => {
    cursor = 0; effects.length = 0;
    const tree = output.exports.OrchestrationGraphPanel(props);
    for (const node of allElements(tree)) if (node.props?.ref != null && node.type === "View") node.props.ref.current = target;
    effects.splice(0).forEach((effect) => effect());
    return tree;
  };
  const animated = (tree) => allElements(tree).find((node) => node.type === "AnimatedView");
  const graphCanvas = (tree) => allElements(tree).find((node) => node.type === "GraphCanvas");
  const transform = (tree) => animated(tree).props.style.at(-1).transform;
  let tree = render();
  tree.props.onLayout({ nativeEvent: { layout: { width: 1000, height: 800 } } });
  allElements(tree).find((node) => node.props?.ref?.current === target)
    .props.onLayout({ nativeEvent: { layout: { x: 24, y: 150, width: 800, height: 600 } } });
  tree = render();
  assert.equal(transform(tree)[2].scale, 1);
  wheel(-100, { x: 250, y: 200 });
  wheel(-100, { x: 250, y: 200 }); // 렌더 사이 휠도 직전 카메라·배율에서 누적한다.
  tree = render();
  const scale = Math.exp(0.4);
  near(transform(tree)[2].scale, scale);
  assert.equal(animated(tree).props.style.at(-1).transformOrigin, "0 0");
  near(transform(tree)[0].translateX, 250 * (1 - scale));
  const pan = animated(tree).props;
  pan.onPanResponderGrant();
  const initialX = transform(tree)[0].translateX;
  pan.onPanResponderMove(null, { dx: 40, dy: 20 });
  tree = render();
  near(transform(tree)[0].translateX, initialX + 40); // 줌된 팬도 화면 픽셀이다.
  graphCanvas(tree).props.onNodePress("node-agent");
  assert.equal(opened.length, 0); // 팬 직후 클릭 억제는 그대로다.
  animated(tree).props.onStartShouldSetPanResponderCapture();
  graphCanvas(tree).props.onNodePress("node-agent");
  assert.deepEqual(opened, ["node-agent"]);
  const label = { text: "잘린 라벨", left: 300, top: 100, width: 80, height: 28 };
  graphCanvas(tree).props.onLabelHover(label);
  tree = render();
  const tooltip = allElements(tree).find((node) => node.props?.pointerEvents === "none");
  near(tooltip.props.style.at(-1).left, 24 + transform(tree)[0].translateX + 340 * scale - 110);
  near(tooltip.props.style.at(-1).top, 150 + transform(tree)[1].translateY + 128 * scale + 6);
  animated(tree).props.onPanResponderGrant();
  animated(tree).props.onPanResponderMove(null, { dx: -10000, dy: -10000 });
  tree = render();
  const bounds = panBounds(canvas.width, canvas.height, viewport.width, viewport.height, scale);
  near(transform(tree)[0].translateX, bounds.minX);
  near(transform(tree)[1].translateY, bounds.minY);
  graphName = "second";
  render(); tree = render();
  assert.equal(transform(tree)[2].scale, 1);
  assert.equal(transform(tree)[0].translateX, 0);
  assert.equal(transform(tree)[1].translateY, 0);
  assert.equal(graphCanvas(tree).key, "second");
});
