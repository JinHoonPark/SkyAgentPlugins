import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { SpikeScreenProps } from '../types';
import { GraphCanvas, type LabelHover } from './baseline-canvas';
import { viewFor } from './experiment';
import { ROUND2_CANDIDATES, round2Layout, type Round2Candidate } from './round2';

export function GraphEdgeSpike({ theme, layout }: SpikeScreenProps) {
  const [candidateId, setCandidateId] = useState<Round2Candidate['id']>('orderCurve');
  const [availableWidth, setAvailableWidth] = useState(800);
  const [oneToOne, setOneToOne] = useState(false);
  const [narrowSide, setNarrowSide] = useState<'before' | 'after'>('after');
  const [hover, setHover] = useState<LabelHover | null>(null);
  const view = useMemo(() => viewFor(), []);
  const selected = ROUND2_CANDIDATES.find(candidate => candidate.id === candidateId)!;
  const before = useMemo(() => round2Layout(view, layout.compact, ROUND2_CANDIDATES[0]), [view, layout.compact]);
  const after = useMemo(() => round2Layout(view, layout.compact, selected), [view, layout.compact, selected]);
  const narrow = availableWidth < 900;
  const viewportWidth = narrow ? availableWidth : (availableWidth - 12) / 2;
  const viewportHeight = 480;
  const scale = oneToOne ? 1 : Math.min(1,
    viewportWidth / Math.max(before.placed.canvasWidth, after.placed.canvasWidth),
    viewportHeight / Math.max(before.placed.canvasHeight, after.placed.canvasHeight));
  const button = (text: string, action: () => void, active: boolean) => (
    <Pressable onPress={action} style={{ padding: 8, borderWidth: 1,
      borderColor: active ? theme.colors.accent : theme.colors.border, borderRadius: 5,
      backgroundColor: theme.colors.surface1 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{text}</Text>
    </Pressable>
  );
  const pane = (side: 'before' | 'after') => {
    const placed = side === 'before' ? before.placed : after.placed;
    const width = Math.max(viewportWidth, placed.canvasWidth * scale);
    const height = Math.max(viewportHeight, placed.canvasHeight * scale);
    return (
      <View key={side} style={{ width: viewportWidth, gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
          {side === 'before' ? '전 화면 — 개선 전' : '후 화면 — ' + selected.title}
        </Text>
        <View style={{ height: viewportHeight, overflow: 'hidden', backgroundColor: theme.colors.surface1,
          borderWidth: 1, borderColor: theme.colors.border }}>
          <ScrollView horizontal contentContainerStyle={{ width, height: viewportHeight }}>
            <ScrollView nestedScrollEnabled style={{ width, height: viewportHeight }} contentContainerStyle={{ height }}>
              <View style={{ width: placed.canvasWidth * scale, height: placed.canvasHeight * scale }}>
                <View style={{ width: placed.canvasWidth, height: placed.canvasHeight,
                  transform: [{ scale }], transformOrigin: '0 0' }}>
                  <GraphCanvas view={view} placed={placed} colors={theme.colors} onLabelHover={setHover} />
                </View>
              </View>
            </ScrollView>
          </ScrollView>
        </View>
      </View>
    );
  };
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 16 }}>연결선 정돈 비교</Text>
      <View style={{ gap: 6 }}>
        {ROUND2_CANDIDATES.map(candidate => (
          <View key={candidate.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {button(candidate.title, () => { setCandidateId(candidate.id); setHover(null); }, selected.id === candidate.id)}
            <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 11 }}>{candidate.description}</Text>
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {button('전체 보기', () => setOneToOne(false), !oneToOne)}
        {button('원래 크기 100%', () => setOneToOne(true), oneToOne)}
        {narrow ? <>
          {button('전 화면', () => setNarrowSide('before'), narrowSide === 'before')}
          {button('후 화면', () => setNarrowSide('after'), narrowSide === 'after')}
        </> : null}
      </View>
      <View onLayout={event => setAvailableWidth(event.nativeEvent.layout.width)}
        style={{ width: '100%', flexDirection: 'row', gap: 12 }}>
        {narrow ? pane(narrowSide) : <>{pane('before')}{pane('after')}</>}
      </View>
      {hover ? <View style={{ padding: 8, backgroundColor: theme.colors.surface2 }}>
        <Text selectable style={{ color: theme.colors.foreground }}>{hover.text}</Text>
      </View> : null}
    </ScrollView>
  );
}
