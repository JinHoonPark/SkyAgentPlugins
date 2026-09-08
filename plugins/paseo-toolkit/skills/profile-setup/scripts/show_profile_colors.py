#!/usr/bin/env python3
"""Print agent-profile color swatches for profile-setup prompts.

Fill hex is a copy of Paseo app ``IDENTITY_COLORS`` in
``packages/app/src/styles/identity-colors.ts``. Keys follow
``AGENT_PROFILE_COLORS`` in
``packages/app/src/agent-profiles/internal/profile-appearance.ts``
(``none`` plus ``IDENTITY_COLOR_NAMES``).
"""

from __future__ import annotations

import argparse
import ctypes
import os
import sys
from typing import Sequence, TextIO


# Fill swatches from identity-colors.ts IDENTITY_COLORS.  ``none`` has no fill.
COLOR_HEX: dict[str, str] = {
    "violet": "#7a6aa8",
    "sky": "#3d7ea6",
    "emerald": "#388068",
    "orange": "#a4673a",
    "pink": "#b05c80",
    "indigo": "#6a70b8",
    "teal": "#368080",
    "red": "#b06260",
    "amber": "#8f7838",
    "blue": "#5179b0",
}
COLOR_ORDER: tuple[str, ...] = ("none", *COLOR_HEX)
NAME_WIDTH = max(len(name) for name in COLOR_ORDER)
RESET = "\x1b[0m"
BLOCK = "██"


def color_enabled(stream: TextIO) -> bool:
    if os.environ.get("NO_COLOR", "") != "":
        return False
    isatty = getattr(stream, "isatty", None)
    return bool(isatty and isatty())


def enable_windows_vt(stream: TextIO) -> None:
    if sys.platform != "win32":
        return
    try:
        fileno = stream.fileno()
    except (AttributeError, OSError, ValueError):
        return
    # STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12
    handle_id = -11 if fileno == 1 else -12 if fileno == 2 else None
    if handle_id is None:
        return
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.GetStdHandle(handle_id)
    mode = ctypes.c_uint()
    if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
        return
    kernel32.SetConsoleMode(handle, mode.value | 0x0004)


def rgb_from_hex(hex_color: str) -> tuple[int, int, int]:
    text = hex_color.removeprefix("#")
    return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)


def format_color_line(name: str, *, use_color: bool) -> str:
    hex_color = COLOR_HEX.get(name)
    if hex_color is None:
        return name
    label = f"{name:<{NAME_WIDTH}}  ({hex_color})"
    if not use_color:
        return label
    red, green, blue = rgb_from_hex(hex_color)
    return f"\x1b[38;2;{red};{green};{blue}m{BLOCK}{RESET}  {label}"


def resolve_names(requested: Sequence[str]) -> list[str]:
    if not requested:
        return list(COLOR_ORDER)
    unknown = [name for name in requested if name not in COLOR_ORDER]
    if unknown:
        raise ValueError("unknown color: " + ", ".join(unknown))
    return list(requested)


def emit_lines(lines: Sequence[str], stream: TextIO) -> None:
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    buffer = getattr(stream, "buffer", None)
    if buffer is not None:
        buffer.write(payload)
        buffer.flush()
        return
    stream.write(payload.decode("utf-8"))
    stream.flush()


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Print Paseo agent-profile color swatches (truecolor when stdout is a TTY)."
    )
    parser.add_argument(
        "colors",
        nargs="*",
        help="Color keys to print, in order. Default: the 11 registry values.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = make_parser()
    args = parser.parse_args(argv)
    try:
        names = resolve_names(args.colors)
    except ValueError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2
    use_color = color_enabled(sys.stdout)
    if use_color:
        enable_windows_vt(sys.stdout)
    emit_lines([format_color_line(name, use_color=use_color) for name in names], sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
