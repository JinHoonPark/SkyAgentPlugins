import type { PluginServerContext } from "@getpaseo/plugin/server";
import { requestSpikeCheck } from "./server/checklist";
import { requestSpikeCheckRpc } from "./shared/checklist";

export default function contribute(server: PluginServerContext) {
  server.handle(requestSpikeCheckRpc, requestSpikeCheck);
  return () => {};
}
