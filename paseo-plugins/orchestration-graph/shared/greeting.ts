import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const greetingRpc = defineRpc({
  name: "greeting.create",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
});
