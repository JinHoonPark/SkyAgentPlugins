/**
 * 테마가 주는 색 문자열만으로 밝기를 계산한다.
 * 색을 새로 정하는 것이 아니라 받은 값을 읽는 것이므로 색상 하드코딩이 아니다.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** hex(#rgb·#rrggbb·#rrggbbaa)와 rgb()/rgba()만 읽는다. 그 밖의 표기는 null. */
export function parseColor(value: string): Rgb | null {
  const text = value.trim();

  if (text.startsWith("#")) {
    const body = text.slice(1);
    if (body.length === 3 || body.length === 4) {
      const r = hexPair(body[0] + body[0]);
      const g = hexPair(body[1] + body[1]);
      const b = hexPair(body[2] + body[2]);
      return r == null || g == null || b == null ? null : { r, g, b };
    }
    if (body.length === 6 || body.length === 8) {
      const r = hexPair(body.slice(0, 2));
      const g = hexPair(body.slice(2, 4));
      const b = hexPair(body.slice(4, 6));
      return r == null || g == null || b == null ? null : { r, g, b };
    }
    return null;
  }

  const match = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (match == null) {
    return null;
  }
  const parts = match[1].split(/[\s,/]+/).filter((part) => part.length > 0);
  if (parts.length < 3) {
    return null;
  }
  const channels = parts.slice(0, 3).map(readChannel);
  return channels.every((channel) => channel != null)
    ? { r: channels[0]!, g: channels[1]!, b: channels[2]! }
    : null;
}

function hexPair(text: string): number | null {
  const parsed = Number.parseInt(text, 16);
  return Number.isNaN(parsed) ? null : parsed;
}

function readChannel(text: string): number | null {
  const parsed = text.endsWith("%")
    ? Math.round((Number.parseFloat(text) / 100) * 255)
    : Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? null : Math.max(0, Math.min(255, parsed));
}

/** WCAG 상대 휘도. 0(검정)~1(흰색). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * linearize(r / 255) + 0.7152 * linearize(g / 255) + 0.0722 * linearize(b / 255);
}

function linearize(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** 두 색의 WCAG 대비비. 1(같은 색)~21(검정 대 흰색). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export type EstimatedAppearance = "light" | "dark" | "unknown";

/**
 * surface0의 상대 휘도로 현재 테마의 라이트/다크를 추정한다.
 * 임계값은 예비 수단이며, 호스트 테마를 바꿔가며 추정이 맞는지 눈으로 대조한다.
 */
export function estimateAppearance(surface0: string, threshold = 0.5): EstimatedAppearance {
  const parsed = parseColor(surface0);
  if (parsed == null) {
    return "unknown";
  }
  return relativeLuminance(parsed) < threshold ? "dark" : "light";
}

export function formatRgb(color: Rgb | null): string {
  return color == null ? "파싱 불가" : "rgb(" + String(color.r) + ", " + String(color.g) + ", " + String(color.b) + ")";
}

export function formatNumber(value: number, digits = 3): string {
  return value.toFixed(digits);
}
