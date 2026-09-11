import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getGraph, listGraphs, readGraphFile } from "./server/graphs";
import { getGraphRpc, listGraphsRpc, readGraphFileRpc } from "./shared/graphs";

export default function contribute(server: PluginServerContext) {
  server.handle(listGraphsRpc, listGraphs);
  server.handle(getGraphRpc, getGraph);
  server.handle(readGraphFileRpc, readGraphFile);
  return () => {};
}
