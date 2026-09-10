import type { RpcInput } from "@getpaseo/plugin";
import { greetingRpc } from "../shared/greeting";

export function createGreeting({ name }: RpcInput<typeof greetingRpc>) {
  return { message: "Hello, " + name + "!" };
}
