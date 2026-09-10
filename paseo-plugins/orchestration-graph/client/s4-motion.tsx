import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Text, View } from "react-native";
import { registerStop } from "./cleanup";

function pingPong(value: Animated.Value, useNativeDriver: boolean, alive: { current: boolean }) {
  const run = () => {
    if (!alive.current) {
      return;
    }
    Animated.sequence([
      Animated.timing(value, { toValue: 80, duration: 600, useNativeDriver }),
      Animated.timing(value, { toValue: 0, duration: 600, useNativeDriver }),
    ]).start(({ finished }) => {
      if (finished && alive.current) {
        run();
      }
    });
  };
  run();
}

export function MotionProbes({
  foreground,
  muted,
  accent,
}: {
  foreground: string;
  muted: string;
  accent: string;
}) {
  const [ticks, setTicks] = useState(0);
  const [ticksPerSec, setTicksPerSec] = useState(0);
  const [timeoutText, setTimeoutText] = useState("timeout=waiting");
  const [rafFrames, setRafFrames] = useState(0);
  const [rafDelta, setRafDelta] = useState(0);
  const [rafStatus, setRafStatus] = useState("rAF=init");
  const nativeX = useRef(new Animated.Value(0)).current;
  const jsX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let intervalTicks = 0;
    let windowTicks = 0;
    let windowStart = Date.now();
    const intervalId = setInterval(() => {
      intervalTicks += 1;
      windowTicks += 1;
      setTicks(intervalTicks);
      const elapsed = Date.now() - windowStart;
      if (elapsed >= 1000) {
        setTicksPerSec(windowTicks);
        windowTicks = 0;
        windowStart = Date.now();
      }
    }, 100);
    const timeoutId = setTimeout(() => {
      setTimeoutText(`timeout=fired at ${Date.now()}`);
    }, 1000);

    let rafId = 0;
    let last = Date.now();
    let frames = 0;
    const hasRaf = typeof requestAnimationFrame === "function";
    if (!hasRaf) {
      setRafStatus("rAF=unavailable");
    } else {
      setRafStatus("rAF=running");
      const loop = () => {
        const now = Date.now();
        frames += 1;
        setRafFrames(frames);
        setRafDelta(now - last);
        last = now;
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    }

    const alive = { current: true };
    pingPong(nativeX, true, alive);
    pingPong(jsX, false, alive);

    const stop = () => {
      clearInterval(intervalId);
      clearTimeout(timeoutId);
      if (rafId && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      alive.current = false;
      nativeX.stopAnimation();
      jsX.stopAnimation();
    };
    return registerStop(stop);
  }, [jsX, nativeX]);

  const box = useMemo(
    () => ({
      width: 36,
      height: 36,
      backgroundColor: accent,
    }),
    [accent],
  );

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: foreground, fontSize: 20 }}>S4 motion</Text>
      <Text style={{ color: muted }}>interval 100ms, timeout 1s, rAF, Animated native/js</Text>
      <Text style={{ color: foreground }}>intervalTicks={ticks} ticksPerSec={ticksPerSec}</Text>
      <Text style={{ color: foreground }}>{timeoutText}</Text>
      <Text style={{ color: foreground }}>
        {rafStatus} frames={rafFrames} deltaMs={rafDelta}
      </Text>
      <Text style={{ color: muted }}>nativeDriver=true</Text>
      <Animated.View style={[box, { transform: [{ translateX: nativeX }] }]} />
      <Text style={{ color: muted }}>nativeDriver=false</Text>
      <Animated.View style={[box, { transform: [{ translateX: jsX }] }]} />
    </View>
  );
}
