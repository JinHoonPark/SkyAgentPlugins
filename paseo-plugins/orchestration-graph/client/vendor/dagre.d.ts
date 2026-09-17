// dagre.js는 `npm run vendor:dagre`가 만든 자족 번들이다. 설치본에는 node_modules가 없고,
// 호스트는 선언 파일의 import/export를 전부 타입 의존성으로 해석하므로 바깥 패키지를 참조할 수 없다.
// 그래서 panel.tsx가 쓰는 표면만 여기에 직접 선언한다. dagre를 갱신하면 이 파일도 함께 확인한다.

interface DagreGraphLabel {
  rankdir?: string;
  nodesep?: number;
  ranksep?: number;
}

interface DagreNodeLabel {
  width?: number;
  height?: number;
}

declare class DagreGraph {
  constructor(options?: { directed?: boolean; multigraph?: boolean; compound?: boolean });
  setGraph(label: DagreGraphLabel): this;
  setDefaultEdgeLabel(label: () => unknown): this;
  setNode(id: string, label?: DagreNodeLabel): this;
  setEdge(v: string, w: string, label?: unknown, name?: string): this;
  node(id: string): unknown;
  edge(v: string, w: string, name?: string): unknown;
}

declare const dagre: {
  graphlib: { Graph: typeof DagreGraph };
  layout(graph: DagreGraph, options?: DagreGraphLabel): void;
};

export default dagre;
