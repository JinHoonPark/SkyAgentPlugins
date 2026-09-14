import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { View } from "react-native";
import { OrchestrationGraphPanel } from "./panel";

// Composer pill popovers render in a fixed MenuSurface: minWidth 280, maxWidth 420,
// maxHeight 440 (scrollable). The plugin content box loses the surface border (1px per side)
// plus the plugin content wrapper padding (12px per side) horizontally, and vertically also
// the MenuPage paddingVertical (4px per side). Size the content to that remaining area.
const SURFACE_MAX_WIDTH = 420;
const SURFACE_MAX_HEIGHT = 440;
const SURFACE_BORDER = 1;
const CONTENT_PADDING = 12;
const PAGE_PADDING_Y = 4;
const SURFACE_CHROME_X = 2 * SURFACE_BORDER + 2 * CONTENT_PADDING;
const SURFACE_CHROME_Y = 2 * SURFACE_BORDER + 2 * CONTENT_PADDING + 2 * PAGE_PADDING_Y;
const POPOVER_WIDTH = SURFACE_MAX_WIDTH - SURFACE_CHROME_X;
const POPOVER_HEIGHT = SURFACE_MAX_HEIGHT - SURFACE_CHROME_Y;

export function GraphPopoverContent(props: PluginButtonContentProps) {
  if (props.context !== "agent") {
    return null;
  }
  return (
    <View style={{ width: POPOVER_WIDTH, height: POPOVER_HEIGHT }}>
      <OrchestrationGraphPanel
        theme={props.theme}
        host={props.host}
        layout={props.layout}
        context="agent"
        workspaceId={props.workspaceId}
        agentId={props.agentId}
      />
    </View>
  );
}
