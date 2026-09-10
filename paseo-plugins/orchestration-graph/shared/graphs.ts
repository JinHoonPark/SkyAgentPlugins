import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const listGraphsRpc = defineRpc({
  name: "graphs.list",
  input: z.object({ directory: z.string() }),
  output: z.object({ names: z.array(z.string()) }),
});

export const graphNodeStatus = z.enum(["대기", "실행 중", "완료", "실패"]);

export const getGraphRpc = defineRpc({
  name: "graphs.get",
  input: z.object({
    directory: z.string(),
    name: z.string(),
  }),
  output: z.object({
    name: z.string(),
    waiting: z.boolean(),
    root: z
      .object({
        id: z.string(),
        name: z.string(),
        status: graphNodeStatus,
      })
      .nullable(),
    nodes: z.array(
      z.object({
        id: z.string(),
        profile: z.string(),
        tableStatus: z.string(),
        agentId: z.string().nullable(),
        displayName: z.string(),
        status: graphNodeStatus,
      }),
    ),
  }),
});
