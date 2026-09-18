import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerStop, stopAll } from "./client/cleanup";
import { OrchestrationGraphPanel } from "./client/panel";
import { findGraphByAgentRpc, getGraphRpc } from "./shared/graphs";

const ORCHESTRATION_GRAPH_PANEL_ID = "orchestration-graph";

export default function contribute(client: PluginClientContext) {
  // The panel is keyed by its agent id, so pinning it to the graph root keeps a single explorer
  // panel across the pills of every agent in the same graph. A graph whose root cannot be
  // resolved falls back to the pressing agent, which may open more than one panel.
  const openGraphPanel = async (workspaceId: string, agentId: string) => {
    // 그래프를 찾은 뒤에는 이 id로 다시 조회해도 같은 그래프가 최초 선택으로 남을 때만 루트 id를 쓴다.
    // 루트로 옮겨 갔더니 그 id의 목록이 비거나 다른 그래프를 고르면 요청받은 id를 그대로 유지한다.
    // 폴백으로 고른 그래프는 요청받은 id로 계속 조회해야 한 개로 남으므로 루트로 옮기지 않는다.
    let panelAgentId = agentId;
    try {
      const handle = client.paseo.workspaces.ref(workspaceId);
      const workspace = handle.current() ?? (await handle.refresh());
      const directory = workspace?.workspaceDirectory ?? null;
      if (directory != null) {
        const found = await client.rpc(findGraphByAgentRpc, { directory, agentId });
        const chosen = found.items[0] ?? null;
        if (chosen != null && !chosen.fallback) {
          const view = await client.rpc(getGraphRpc, { directory, name: chosen.name });
          const rootAgentId = view.root?.id ?? null;
          if (rootAgentId != null) {
            const reopened = await client.rpc(findGraphByAgentRpc, { directory, agentId: rootAgentId });
            if (reopened.items[0]?.name === chosen.name) {
              panelAgentId = rootAgentId;
            }
          }
        }
      }
    } catch {
      // Any lookup failure still opens the panel, which reports the missing graph itself.
    }
    client.openPanel(ORCHESTRATION_GRAPH_PANEL_ID, {
      workspaceId,
      agentId: panelAgentId,
      location: "explorer",
    });
  };

  client.addWorkspacePanel({
    id: ORCHESTRATION_GRAPH_PANEL_ID,
    title: "오케스트레이션 그래프",
    icon: "Workflow",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: OrchestrationGraphPanel,
  });

  const pillStops = new Map<string, () => void>();
  let cleanedUp = false;
  type Agent = Awaited<ReturnType<typeof client.paseo.agents.list>>["entries"][number]["agent"];
  const registerAgentPill = (agent: Agent) => {
    const { id: agentId, workspaceId } = agent;
    if (cleanedUp || workspaceId == null || pillStops.has(agentId)) {
      return;
    }

    const pillRegistration = client.addComposerPill({
      id: "orchestration-graph-pill",
      workspaceId,
      agentId,
      button: {
        title: "오케스트레이션 그래프",
        icon: "Workflow",
        label: "그래프",
        behavior: {
          kind: "action",
          onPress: () => openGraphPanel(workspaceId, agentId),
        },
      },
    });
    const unregisterPill = registerStop(() => {
      pillRegistration.remove();
    });
    pillStops.set(agentId, unregisterPill);
  };

  const stopSubscription = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      pillStops.get(update.agentId)?.();
      pillStops.delete(update.agentId);
      return;
    }

    registerAgentPill(update.agent);
  });
  registerStop(stopSubscription);

  void client.paseo.agents.list().then(
    (listed) => {
      if (cleanedUp) {
        return;
      }
      for (const entry of listed.entries) {
        registerAgentPill(entry.agent);
      }
    },
    () => {},
  );

  return () => {
    cleanedUp = true;
    stopAll();
    pillStops.clear();
  };
}
