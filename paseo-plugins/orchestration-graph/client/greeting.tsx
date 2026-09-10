import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { greetingRpc } from "../shared/greeting";
import { openExternal } from "./web";

export function GreetingSurface({ theme, layout }: PluginSurfaceProps) {
  const createGreeting = useRpc(greetingRpc);
  const greeting = useMutation({ mutationFn: createGreeting });
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      text: { color: theme.colors.foreground },
      button: { padding: 12, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.text}>{greeting.data?.message ?? "Ask the daemon for a greeting."}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create greeting"
        style={styles.button}
        onPress={() => greeting.mutate({ name: "Paseo" })}
      >
        <Text style={styles.buttonText}>Create greeting</Text>
      </Pressable>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Open the Paseo website"
        style={styles.button}
        onPress={() => openExternal("https://paseo.sh")}
      >
        <Text style={styles.buttonText}>Open paseo.sh</Text>
      </Pressable>
    </View>
  );
}
