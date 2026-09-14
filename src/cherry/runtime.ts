export type CherryFeatureState = "native" | "web-adapted" | "simulated" | "host-dependent";

export type CherryFeature = {
  id: string;
  name: string;
  state: CherryFeatureState;
  summary: string;
};

export const cherryFeatures: CherryFeature[] = [
  { id: "imgui", name: "Dear ImGui compatibility", state: "web-adapted", summary: "Immediate-style controls are mapped to React widgets and dense workbench panels." },
  { id: "lua", name: "Lua scripting", state: "simulated", summary: "A safe Cherry command pad supports script-like print, sound, hook, theme, and draw commands." },
  { id: "sound", name: "Sound engine", state: "native", summary: "Uses Web Audio channels for short application sounds." },
  { id: "drawing", name: "Drawing API", state: "native", summary: "Canvas drawing primitives cover rectangles, lines, circles, grids, and animated hooks." },
  { id: "textures", name: "Images / textures", state: "native", summary: "Local and remote images can be loaded as texture-like UI assets." },
  { id: "fonts", name: "Fonts", state: "native", summary: "Runtime font samples use system and bundled-safe font stacks." },
  { id: "io", name: "I/O API", state: "native", summary: "Keyboard, pointer, and button state are tracked in the workbench." },
  { id: "hooks", name: "Hooks", state: "native", summary: "Frame and second hooks drive animation, counters, and diagnostics." },
  { id: "i18n", name: "Translation / accessibility", state: "native", summary: "Accessible controls, labels, and small runtime language switches are exposed." },
  { id: "themes", name: "Themes builder", state: "native", summary: "Palette tokens can be changed live and applied to the Cherry workbench." },
  { id: "widgets", name: "Components / widgets builder", state: "native", summary: "Buttons, sliders, toggles, lists, tables, panels, and previews are available." },
  { id: "network", name: "Network fetch", state: "native", summary: "HTTPS fetch tester mirrors Cherry network utility workflows." },
  { id: "docking", name: "Advanced docking", state: "web-adapted", summary: "Resizable-looking dock presets switch between inspector, console, and preview layouts." },
  { id: "markdown", name: "Markdown renderer", state: "native", summary: "A safe inline markdown renderer previews common authoring syntax." },
  { id: "features", name: "Choose your features", state: "native", summary: "Feature flags can be enabled and disabled at runtime." },
  { id: "contexts", name: "Multiple contexts", state: "web-adapted", summary: "Independent panels maintain separate state contexts inside one application shell." },
  { id: "compute", name: "Compute shaders", state: "host-dependent", summary: "WebGPU availability is detected; CPU fallback diagnostics remain available." },
  { id: "kms", name: "KMS / DRM rendering", state: "host-dependent", summary: "Desktop shell packaging supports host renderers; direct KMS is outside the webview target." },
  { id: "debug", name: "Debug tools", state: "native", summary: "Runtime state, feature flags, FPS, fetch output, and script logs are inspectable." },
  { id: "builtin", name: "Built-in components / themes", state: "native", summary: "Cherry-style themes and component presets ship in the app." }
];

export const cherryThemes = {
  cherryDark: {
    name: "Cherry Dark",
    background: "#202127",
    panel: "#2d2e34",
    panelAlt: "#36373e",
    accent: "#2a82da",
    text: "#e1e5f2",
    muted: "#aab2be"
  },
  ember: {
    name: "Ember",
    background: "#211f21",
    panel: "#302a2f",
    panelAlt: "#3a3238",
    accent: "#da822a",
    text: "#f1e8dd",
    muted: "#c2aca0"
  },
  graphite: {
    name: "Graphite",
    background: "#1f2224",
    panel: "#2b3033",
    panelAlt: "#353b3f",
    accent: "#82da2a",
    text: "#e5ecee",
    muted: "#a8b5b9"
  }
} as const;

export type CherryThemeId = keyof typeof cherryThemes;

export function detectWebGpu(): string {
  return "gpu" in navigator ? "available" : "not available";
}
