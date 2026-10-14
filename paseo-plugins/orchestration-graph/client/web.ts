import { Linking, Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const window: { open(url: string, target: string, features: string): unknown };

type WheelInput = {
  clientX: number;
  clientY: number;
  deltaY: number;
  deltaMode: number;
  preventDefault(): void;
  stopPropagation(): void;
};
type WheelTarget = {
  getBoundingClientRect(): { left: number; top: number; height: number };
  addEventListener(type: "wheel", listener: (event: WheelInput) => void, options: { passive: false; capture: true }): void;
  removeEventListener(type: "wheel", listener: (event: WheelInput) => void, capture: true): void;
};

export function listenGraphWheel(
  view: unknown,
  onWheel: (deltaY: number, cursor: { x: number; y: number }) => void,
): () => void {
  if (Platform.OS !== "web" || view == null) {
    return () => {};
  }
  const target = view as WheelTarget;
  const listener = (event: WheelInput) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = target.getBoundingClientRect();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    onWheel(event.deltaY * unit, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };
  target.addEventListener("wheel", listener, { passive: false, capture: true });
  return () => target.removeEventListener("wheel", listener, true);
}

export async function openExternal(url: string): Promise<void> {
  if (Platform.OS === "web") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await Linking.openURL(url);
}
