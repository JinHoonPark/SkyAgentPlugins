import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { SpikeTimelineData } from "../shared/checklist";

/**
 * 확인 요청 행. 사람에게 육안 확인을 부탁하는 문구와 선택된 항목만 보여준다.
 * 확인 결과를 표시하거나 단정하는 문구는 넣지 않는다.
 */
export function SpikeCheckRow({ theme, layout, item }: PluginTimelineItemProps<SpikeTimelineData>) {
  const items = item.data.items;
  const styles = useMemo(
    () => ({
      card: {
        gap: 6,
        padding: layout.compact ? 10 : 12,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
      },
      heading: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 13 : 14,
        fontWeight: "600" as const,
      },
      item: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 12 : 13,
      },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>아래 항목을 화면에서 육안으로 확인해 주세요</Text>
      {items.map((label: string, index: number) => (
        <Text key={label + ":" + String(index)} style={styles.item}>
          {"• " + label}
        </Text>
      ))}
    </View>
  );
}
