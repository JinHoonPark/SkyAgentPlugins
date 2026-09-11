import {
  displayName,
  foldNodeStatuses,
  resolveRoot,
  synthesizeStatus,
  type GraphAgentSnapshot,
  type GraphView,
} from "../shared/graphs";

export function toAgentSnapshot(agent: {
  id: string;
  title: string | null;
  status: GraphAgentSnapshot["status"];
  labels?: Readonly<Record<string, string>>;
}): GraphAgentSnapshot {
  return {
    id: agent.id,
    title: agent.title,
    status: agent.status,
    labels: agent.labels ?? {},
  };
}

export function applyLiveGraph(
  data: GraphView,
  snapshots: ReadonlyMap<string, GraphAgentSnapshot>,
): GraphView {
  const nodes = data.nodes.map((node) => {
    if (!node.fromTable || node.agentId == null) {
      return node;
    }
    const snap = snapshots.get(node.agentId);
    if (snap == null) {
      return node;
    }
    return {
      ...node,
      displayName: displayName(node.profile, node.agentId, snap),
      status: synthesizeStatus(node.agentId, node.tableStatus, snap),
    };
  });
  const tableNodes = nodes.filter((node) => node.fromTable);
  const waiting = tableNodes.every((node) => node.agentId == null);
  if (waiting) {
    return { ...data, waiting: true, root: null, nodes };
  }
  const rows = tableNodes.map((node) => ({
    id: node.id,
    profile: node.profile,
    tableStatus: node.tableStatus,
    agentId: node.agentId,
  }));
  const tableStatuses = tableNodes.map((node) => node.status).filter((status) => status != null);
  const resolved = resolveRoot(
    rows,
    new Map(snapshots),
    tableStatuses,
  );
  if (resolved != null) {
    return { ...data, waiting: false, root: resolved, nodes };
  }
  if (data.root == null) {
    return { ...data, waiting: false, root: null, nodes };
  }
  const rootSnap = snapshots.get(data.root.id);
  if (rootSnap == null) {
    return { ...data, waiting: false, root: data.root, nodes };
  }
  const folded = foldNodeStatuses(tableStatuses);
  return {
    ...data,
    waiting: false,
    root: {
      id: data.root.id,
      name: displayName(data.root.id, data.root.id, rootSnap),
      status: synthesizeStatus(data.root.id, folded, rootSnap),
    },
    nodes,
  };
}
