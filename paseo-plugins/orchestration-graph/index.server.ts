import type { PluginServerContext } from "@getpaseo/plugin/server";
import { findGraphByAgent, getGraph, readGraphFile } from "./server/graphs";
import { findGraphByAgentRpc, getGraphRpc, readGraphFileRpc } from "./shared/graphs";

export default function contribute(server: PluginServerContext) {
  server.handle(findGraphByAgentRpc, findGraphByAgent);
  server.handle(getGraphRpc, getGraph);
  server.handle(readGraphFileRpc, readGraphFile);
  return () => {};
}
