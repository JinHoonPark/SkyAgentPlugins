// SPIKE-N1 ONLY — delete this file and every `SPIKE-N1` marker once the
// measurements for node N1 are written. Nothing here is meant to ship.
import { useEffect, useRef, useState } from "react";
import { Animated, Text, View } from "react-native";
import { registerStop } from "./cleanup";

// Exp4 baseline switch. false = every repeat animation off (baseline run).
export const SPIKE_PERF_ON = true;

export const SPIKE_LOOP_MS = 900;

export type SpikeVariant =
  | "1a" // card boxShadow driven by an Animated interpolate
  | "1bt" // sibling back view glow, transparent card
  | "1bc" // sibling back view glow, card-colored card
  | "1d" // addListener + per-frame setState boxShadow
  | "2a" // dedicated loop on borderColor + left bar backgroundColor
  | "2b" // overlay view, opacity-only loop
  | "3a" // icon wrapper + rotation + explicit transformOrigin
  | "3b" // icon wrapper + rotation + default transformOrigin
  | "3c" // icon wrapper only, no rotation
  | null;

const TAGS: Array<[string, SpikeVariant]> = [
  ["V1A", "1a"],
  ["V1B", "1bt"],
  ["V1C", "1bc"],
  ["V1D", "1d"],
  ["V2A", "2a"],
  ["V2B", "2b"],
  ["V3A", "3a"],
  ["V3B", "3b"],
  ["V3C", "3c"],
];

// Variant is carried by the node's profile text, so a fixture file alone selects it.
export function spikeVariant(profileText: string): SpikeVariant {
  if (!SPIKE_PERF_ON) {
    return null;
  }
  for (const [tag, variant] of TAGS) {
    if (profileText.startsWith(tag)) {
      return variant;
    }
  }
  return null;
}

// 0 -> 1 -> 0 forever while active. JS-driven on purpose: this host has no
// native animated module, and Exp2's colour loop requires useNativeDriver:false anyway.
export function useSpikeLoop(active: boolean, native = false): Animated.Value {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      t.setValue(0);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: SPIKE_LOOP_MS, useNativeDriver: native }),
        Animated.timing(t, { toValue: 0, duration: SPIKE_LOOP_MS, useNativeDriver: native }),
      ]),
    );
    anim.start();
    return registerStop(() => {
      anim.stop();
      t.setValue(0);
    });
  }, [active, native, t]);
  return t;
}

export function hexTriplet(hex: string): string {
  const raw = hex.replace("#", "").trim();
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return "120, 120, 120";
  }
  return `${r}, ${g}, ${b}`;
}

// Exp4 — measured on the canvas, so it reports the interval the canvas actually gets.
export function SpikeFrameMeter() {
  const [stats, setStats] = useState("measuring…");
  useEffect(() => {
    let stopped = false;
    let raf = 0;
    let windowStart = performance.now();
    let last = windowStart;
    let frames = 0;
    let sum = 0;
    let max = 0;
    let worstAt = 0;
    const tick = (now: number) => {
      if (stopped) {
        return;
      }
      const dt = now - last;
      last = now;
      if (frames > 0) {
        sum += dt;
        if (dt > max) {
          max = dt;
          worstAt = now - windowStart;
        }
      }
      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed >= 10000) {
        const avg = sum / Math.max(1, frames - 1);
        setStats(
          `${frames}f/${(elapsed / 1000).toFixed(1)}s avg ${avg.toFixed(1)}ms max ${max.toFixed(1)}ms @${(worstAt / 1000).toFixed(1)}s`,
        );
        windowStart = now;
        frames = 0;
        sum = 0;
        max = 0;
        worstAt = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return registerStop(() => {
      stopped = true;
      cancelAnimationFrame(raf);
    });
  }, []);
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 6,
        top: 6,
        zIndex: 99,
        backgroundColor: "#000000d9",
        paddingHorizontal: 6,
        paddingVertical: 4,
      }}
    >
      <Text selectable={false} style={{ color: "#ffffff", fontSize: 11, lineHeight: 14 }}>
        {stats}
      </Text>
    </View>
  );
}
