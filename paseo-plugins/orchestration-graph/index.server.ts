import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGreeting } from "./server/greeting";
import { getGraph, listGraphs } from "./server/graphs";
import { greetingRpc } from "./shared/greeting";
import { getGraphRpc, listGraphsRpc } from "./shared/graphs";

export default function contribute(server: PluginServerContext) {
  server.handle(greetingRpc, createGreeting);
  server.handle(listGraphsRpc, listGraphs);
  server.handle(getGraphRpc, getGraph);
  return () => {};
}
