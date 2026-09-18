import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  findGraphByAgent,
  getGraph,
  readGraphFile,
  retryGraphSummaryHandler,
} from "./server/graphs";
import {
  findGraphByAgentRpc,
  getGraphRpc,
  readGraphFileRpc,
  retryGraphSummaryRpc,
} from "./shared/graphs";

export default function contribute(server: PluginServerContext) {
  server.handle(findGraphByAgentRpc, findGraphByAgent);
  server.handle(getGraphRpc, getGraph);
  server.handle(readGraphFileRpc, readGraphFile);
  server.handle(retryGraphSummaryRpc, retryGraphSummaryHandler);
  return () => {};
}
