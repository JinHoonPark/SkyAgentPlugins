import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerStop, stopAll } from "./client/cleanup";
import { SpikePanel } from "./client/checklist-panel";
import { SpikeCheckRow } from "./client/checklist-renderer";
import { spikeTimelineData, spikeTimelineKind, spikeTimelineVersion } from "./shared/checklist";

const SPIKE_PANEL_ID = "spike-plugin";

export default function contribute(client: PluginClientContext) {
  // pill은 체크 UI를 담지 않는다. 항목 목록이 길어 popover 크기 상한에 걸리므로
  // explorer 위치의 패널 본문에만 둔다.
  const openSpikePanel = (workspaceId: string, agentId: string) => {
    client.openPanel(SPIKE_PANEL_ID, { workspaceId, agentId, location: "explorer" });
  };

  registerStop(
    client.addWorkspacePanel({
      id: SPIKE_PANEL_ID,
      title: "시각 스파이크 확인",
      icon: "ListChecks",
      context: "agent",
      locations: ["workspace", "explorer"],
      Component: SpikePanel,
    }),
  );

  registerStop(
    client.addTimelineRenderer({
      kind: spikeTimelineKind,
      version: spikeTimelineVersion,
      schema: spikeTimelineData,
      Component: SpikeCheckRow,
    }),
  );

  const pillStops = new Map<string, () => void>();
  let cleanedUp = false;
  type Agent = Awaited<ReturnType<typeof client.paseo.agents.list>>["entries"][number]["agent"];
  const registerAgentPill = (agent: Agent) => {
    const { id: agentId, workspaceId } = agent;
    if (cleanedUp || workspaceId == null || pillStops.has(agentId)) {
      return;
    }

    const pillRegistration = client.addComposerPill({
      id: "spike-plugin-pill",
      workspaceId,
      agentId,
      button: {
        title: "시각 스파이크 확인",
        icon: "ListChecks",
        label: "Spike",
        behavior: {
          kind: "action",
          onPress: () => openSpikePanel(workspaceId, agentId),
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
