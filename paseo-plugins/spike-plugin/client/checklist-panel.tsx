import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SPIKE_ITEMS, requestSpikeCheckRpc } from "../shared/checklist";
import { findPrototype } from "./spikes";

/**
 * Explorer 패널. 고정된 항목 목록에서 여러 개를 동시에 고르고,
 * 선택 항목을 현재 에이전트의 타임라인에 확인 요청으로 보낸다.
 * 통과 여부를 판정하거나 저장하지 않는다 — 그 판단은 사람이 화면에서 한다.
 */
export function SpikePanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  const requestCheck = useRpc(requestSpikeCheckRpc);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /** 판정 화면을 열어 둔 항목. null이면 체크 목록을 보여준다. */
  const [openedItem, setOpenedItem] = useState<string | null>(null);

  const toggle = useCallback((label: string) => {
    setStatus(null);
    setSelected((current) =>
      current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label],
    );
  }, []);

  const send = useCallback(async () => {
    if (selected.length === 0) {
      return;
    }
    setSending(true);
    setStatus(null);
    try {
      await requestCheck({ agentId, items: [...selected] });
      setStatus("확인 요청을 이 에이전트의 타임라인에 보냈습니다. 화면에서 직접 확인해 주세요.");
    } catch (error) {
      setStatus("보내지 못했습니다: " + describeError(error));
    } finally {
      setSending(false);
    }
  }, [agentId, requestCheck, selected]);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      content: {
        padding: layout.compact ? 16 : 24,
        gap: 12,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 18 : 22,
        fontWeight: "600" as const,
      },
      label: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 12 : 13,
      },
      list: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
      },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        paddingVertical: layout.compact ? 8 : 10,
        paddingHorizontal: layout.compact ? 10 : 12,
      },
      rowMain: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
      },
      viewButton: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      viewButtonLabel: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 11 : 12,
      },
      screenBar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        paddingVertical: 8,
        paddingHorizontal: layout.compact ? 10 : 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      backButton: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      backLabel: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 11 : 12,
      },
      screenTitle: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: layout.compact ? 13 : 14,
        fontWeight: "600" as const,
      },
      box: {
        width: 20,
        height: 20,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderWidth: 1,
        borderRadius: 4,
      },
      boxOn: {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accent,
      },
      boxOff: {
        borderColor: theme.colors.border,
      },
      check: {
        color: theme.colors.accentForeground,
        fontSize: 13,
        lineHeight: 16,
      },
      rowLabel: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: layout.compact ? 13 : 14,
      },
      button: {
        alignItems: "center" as const,
        justifyContent: "center" as const,
        paddingVertical: layout.compact ? 10 : 12,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonDisabled: {
        backgroundColor: theme.colors.surface2,
      },
      buttonLabel: {
        color: theme.colors.accentForeground,
        fontSize: layout.compact ? 13 : 14,
        fontWeight: "600" as const,
      },
      buttonLabelDisabled: {
        color: theme.colors.foregroundMuted,
      },
      status: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 12 : 13,
      },
    }),
    [theme, layout.compact],
  );

  const canSend = selected.length > 0 && !sending;
  const opened = openedItem == null ? undefined : findPrototype(openedItem);

  if (opened != null) {
    const OpenedScreen = opened.Component;
    return (
      <View style={styles.screen}>
        <View style={styles.screenBar}>
          <Pressable
            style={styles.backButton}
            onPress={() => setOpenedItem(null)}
            accessibilityRole="button"
          >
            <Text style={styles.backLabel}>{"← 체크 목록"}</Text>
          </Pressable>
          <Text style={styles.screenTitle}>{opened.title}</Text>
        </View>
        <OpenedScreen theme={theme} layout={layout} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <Text style={styles.title}>시각 스파이크 확인 요청</Text>
        <Text style={styles.label}>확인할 항목을 고르고 요청을 보내면 이 에이전트의 타임라인에 요청이 추가됩니다.</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.list}>
          {SPIKE_ITEMS.map((entry) => {
            const on = selected.includes(entry);
            const prototype = findPrototype(entry);
            return (
              <View key={entry} style={styles.row}>
                {/* 체크 토글과 보기 버튼을 겹치지 않게 나눠 둔다. 보기를 눌러도 체크는 바뀌지 않는다. */}
                <Pressable
                  style={styles.rowMain}
                  onPress={() => toggle(entry)}
                  accessibilityRole="checkbox"
                >
                  <View style={[styles.box, on ? styles.boxOn : styles.boxOff]}>
                    {on ? <Text style={styles.check}>✓</Text> : null}
                  </View>
                  <Text style={styles.rowLabel}>{entry}</Text>
                </Pressable>
                {prototype == null ? null : (
                  <Pressable
                    style={styles.viewButton}
                    onPress={() => setOpenedItem(entry)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.viewButtonLabel}>보기</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>
        <Pressable
          style={[styles.button, canSend ? null : styles.buttonDisabled]}
          disabled={!canSend}
          onPress={() => {
            void send();
          }}
          accessibilityRole="button"
        >
          <Text style={canSend ? styles.buttonLabel : styles.buttonLabelDisabled}>
            {"선택한 " + String(selected.length) + "개 항목 확인 요청"}
          </Text>
        </Pressable>
        {status == null ? null : <Text style={styles.status}>{status}</Text>}
      </ScrollView>
    </View>
  );
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
