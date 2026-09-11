import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerStop, stopAll } from "./client/cleanup";
import { OrchestrationGraphPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "orchestration-graph",
    title: "오케스트레이션 그래프",
    icon: "Workflow",
    context: "agent",
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
          onPress: () => {
            client.openPanel("orchestration-graph", { workspaceId, agentId });
          },
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
