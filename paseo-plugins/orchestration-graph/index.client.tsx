import type { PluginClientContext } from "@getpaseo/plugin/client";
import { stopAll } from "./client/cleanup";
import { ProbePanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "orchestration-graph",
    title: "오케스트레이션 그래프",
    icon: "PanelsTopLeft",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ProbePanel,
  });
  return () => {
    stopAll();
  };
}
