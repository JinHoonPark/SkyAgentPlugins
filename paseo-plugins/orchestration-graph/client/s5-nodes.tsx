import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

const COUNT = 10;

function layoutNode(index: number) {
  const col = index % 5;
  const row = Math.floor(index / 5);
  return {
    id: `n${index}`,
    left: 12 + col * 70,
    top: 12 + row * 56,
    width: 60,
    height: 40,
  };
}

export function TenNodeProbe({
  foreground,
  muted,
  accent,
  accentForeground,
  surface,
  border,
}: {
  foreground: string;
  muted: string;
  accent: string;
  accentForeground: string;
  surface: string;
  border: string;
}) {
  const [ping, setPing] = useState(0);
  const nodes = useMemo(() => Array.from({ length: COUNT }, (_, index) => layoutNode(index)), []);
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: foreground, fontSize: 20 }}>S5 10-node baseline</Text>
      <Text style={{ color: muted }}>
        {"10 absolute nodes + S4 ticks/animation. ping must feel instant. ticksPerSec must stay >= 8."}
      </Text>
      <Text style={{ color: foreground }}>nodeCount={COUNT} ping={ping}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`S5 ping, currently ${ping}`}
        onPress={() => setPing((value) => value + 1)}
        style={{ padding: 12, borderRadius: 10, backgroundColor: accent }}
      >
        <Text style={{ color: accentForeground, textAlign: "center" }}>S5 ping</Text>
      </Pressable>
      <View
        style={{
          height: 140,
          backgroundColor: surface,
          borderColor: border,
          borderWidth: 1,
          overflow: "hidden",
        }}
      >
        {nodes.map((node) => (
          <View
            key={node.id}
            style={{
              position: "absolute",
              left: node.left,
              top: node.top,
              width: node.width,
              height: node.height,
              backgroundColor: accent,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: accentForeground }}>{node.id}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
