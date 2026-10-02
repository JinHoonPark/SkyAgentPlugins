import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import type { GraphThemeColors } from './motion-logic';
import { pointAlongSegments } from './motion-logic';
import { EdgeLabelView, type LabelHover } from './baseline-canvas';
import { segments, type Experiment, type Size, type Point } from './experiment';
import type { GraphView } from './graph-types';
import { parseColor } from '../color-analysis';

function lowerChroma(color: string, background: string): string {
  const rgb = parseColor(color), base = parseColor(background);
  if (!rgb || !base) return color;
  const gray = (rgb.r + rgb.g + rgb.b) / 3;
  const channel = (value: number, surface: number) => Math.round((value * 0.4 + gray * 0.6) * 0.6 + surface * 0.4);
  return `rgb(${channel(rgb.r, base.r)}, ${channel(rgb.g, base.g)}, ${channel(rgb.b, base.b)})`;
}

function Arrow({ tip, previous, color, background, animated }: { tip: Point; previous: Point; color: string; background: string; animated: boolean }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!animated) { pulse.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }), Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true })]));
    loop.start(); return () => loop.stop();
  }, [animated, pulse]);
  const angle = Math.atan2(tip.y - previous.y, tip.x - previous.x) * 180 / Math.PI;
  const triangle = <View style={{ width: 0, height: 0, borderLeftWidth: 9, borderTopWidth: 4, borderBottomWidth: 4, borderLeftColor: color, borderTopColor: background, borderBottomColor: background }} />;
  return <View pointerEvents="none" style={{ position: 'absolute', left: tip.x - 9, top: tip.y - 4, width: 9, height: 8,
    transform: [{ rotate: `${angle}deg` }], transformOrigin: '100% 50%', zIndex: 1 }}>
    {triangle}{animated ? <Animated.View style={{ position: 'absolute', opacity: pulse, transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] }) }] }}>{triangle}</Animated.View> : null}
  </View>;
}
function Flow({ points, colors }: { points: Point[]; colors: GraphThemeColors }) {
  const x = useRef(new Animated.Value(0)).current, y = useRef(new Animated.Value(0)).current, deg = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let frame = 0; const segs = segments(points, 'flow');
    const tick = (now: number) => { const p = pointAlongSegments(segs, (now % 1600) / 1600);
      if (p) { x.setValue(p.x - 4.5); y.setValue(p.y - 4); deg.setValue(p.deg); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [points, x, y, deg]);
  return <Animated.View pointerEvents="none" style={{ position: 'absolute', width: 9, height: 8, zIndex: 2,
    transform: [{ translateX: x }, { translateY: y }, { rotate: deg.interpolate({ inputRange: [-360, 360], outputRange: ['-360deg', '360deg'] }) }] }}>
    <View style={{ width: 0, height: 0, borderLeftWidth: 9, borderTopWidth: 4, borderBottomWidth: 4, borderLeftColor: colors.accent, borderTopColor: colors.surface1, borderBottomColor: colors.surface1 }} />
  </Animated.View>;
}
export function CandidateLayer({ ex, view, colors, directionMode, selectedDirection, onMeasure, onHover }: {
  ex: Experiment; view: GraphView; colors: GraphThemeColors; directionMode: 'inferred' | 'explicit'; selectedDirection: string | null;
  onMeasure: (key: string, size: Size) => void; onHover: (hover: LabelHover | null) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  return <View pointerEvents="box-none" style={{ position: 'absolute', width: ex.placed.canvasWidth, height: ex.placed.canvasHeight }}>
    {ex.physical.map(path => {
      const paired = path.directions.length === 2;
      const incoming = view.nodes.find(n => n.id === path.directions[0].to)?.status === '실행 중';
      const returnPath = ex.classifications.some(c => c.key === path.key && c.geometric) || path.points.at(-1)!.y < path.points[0].y;
      const muted = ex.options.priority && returnPath && selected !== path.key;
      const color = muted ? lowerChroma(colors.foregroundMuted, colors.surface1) : selected === path.key || incoming && !paired ? colors.accent : colors.foregroundMuted;
      const allSegments = ex.placed.paths.find(p => p.key === path.key)!.segments, total = allSegments.reduce((n, s) => n + s.width, 0);
      let distance = 0;
      return <View key={path.key} pointerEvents="box-none">
        {allSegments.flatMap(s => {
          const start = distance; distance += s.width;
          const cuts = paired && ex.options.attributeMode === 'halves' && start < total / 2 && distance > total / 2 ? [total / 2 - start, s.width - (total / 2 - start)] : [s.width];
          let offset = 0;
          return cuts.map((width, part) => {
            const dashed = paired ? ex.options.attributeMode === 'halves' ? path.directions[start + offset + width / 2 < total / 2 ? 1 : 0].dashed : false : path.directions[0].dashed;
            const rad = s.deg * Math.PI / 180, localOffset = offset; offset += width;
            return <View key={`${s.key}-${part}`} pointerEvents="none" style={{ position: 'absolute', left: s.left + Math.cos(rad) * localOffset, top: s.top + Math.sin(rad) * localOffset,
              width, height: incoming && !paired ? 2 : 1, transform: [{ rotate: `${s.deg}deg` }], transformOrigin: '0 50%', backgroundColor: dashed ? undefined : color, overflow: 'hidden', zIndex: 1 }}>
              {dashed ? Array.from({ length: Math.ceil(width / 14) }, (_, i) => <View key={i} style={{ position: 'absolute', left: i * 14, width: 8, height: incoming && !paired ? 2 : 1, backgroundColor: color }} />) : null}
            </View>;
          });
        })}
        {path.directions.map((d, index) => {
          const tip = index === 0 ? path.points.at(-1)! : path.points[0], previous = index === 0 ? path.points.at(-2)! : path.points[1];
          const active = paired && (directionMode === 'inferred' ? view.nodes.find(n => n.id === d.to)?.status === '실행 중' : selectedDirection === d.from + '-' + d.to);
          return paired || !incoming ? <Arrow key={`${d.from}-${d.to}`} tip={tip} previous={previous} color={muted ? lowerChroma(colors.accent, colors.surface1) : colors.accent} background={colors.surface1} animated={active} /> : null;
        })}
        {!paired && incoming ? <Flow points={path.points} colors={colors} /> : null}
      </View>;
    })}
    {ex.labels.map(label => <View key={label.key} pointerEvents="box-none">
      <EdgeLabelView text={label.text} x={label.left + label.width / 2} y={label.top + label.height / 2} align="center" colors={colors}
        pressTooltip onMeasure={size => onMeasure(label.key, size)} onHover={hover => { if (hover) setSelected(label.pathKey); else setSelected(null); onHover(hover); }} />
      {ex.options.priority ? <Pressable onPress={() => setSelected(selected === label.pathKey ? null : label.pathKey)}
        style={{ position: 'absolute', left: label.left, top: label.top - 14, zIndex: 3 }}><Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>{selected === label.pathKey ? '강조 해제' : '관계 강조'}</Text></Pressable> : null}
    </View>)}
  </View>;
}
