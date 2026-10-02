export type GraphNodeShape = 'rect' | 'hexagon';
export type GraphNodeStatus = '대기' | '실행 중' | '완료' | '실패' | '생략';
export type Direction = { from: string; to: string; dashed: boolean; label: string | null };
export type GraphView = {
  name: string; waiting: boolean;
  root: { id: string; name: string; status: GraphNodeStatus } | null;
  nodes: Array<{ id: string; profile: string; tableStatus: string; agentId: string | null;
    displayName: string; status: GraphNodeStatus | null; fromTable: boolean; labelLines: string[]; shape: GraphNodeShape }>;
  edges: Direction[];
};
