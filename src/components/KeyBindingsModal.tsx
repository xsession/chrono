// v6 keybindings modal + zoom controls (GitKraken RE §View: openKeyBindingsModal / zoomUp / zoomDown / zoomReset).
const SHORTCUTS: Array<[string, string]> = [
  ["Ctrl/⌘ ⇧ P", "Command palette (fuzzy finder)"],
  ["Ctrl/⌘ B", "Toggle left panel"],
  ["Ctrl/⌘ 1", "Working tree view"],
  ["Ctrl/⌘ 2", "History view"],
  ["Ctrl/⌘ 3", "Branches view"],
  ["F5", "Refresh repository"],
  ["Ctrl/⌘ +", "Zoom in"],
  ["Ctrl/⌘ −", "Zoom out"],
  ["Ctrl/⌘ 0", "Reset zoom"],
];

export function KeyBindingsModal({
  open,
  onClose,
  onZoom,
}: {
  open: boolean;
  onClose: () => void;
  onZoom: (direction: "up" | "down" | "reset") => void;
}) {
  if (!open) return null;
  return (
    <div className="ux-modal-backdrop" onClick={onClose}>
      <div className="ux-dialog ux-keybindings-dialog" role="dialog" aria-label="Keyboard shortcuts" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="ux-button compact" onClick={onClose}>Close</button>
        </header>
        <div className="ux-dialog-body">
          <table className="ux-shortcut-table">
            <tbody>
              {SHORTCUTS.map(([keys, label]) => (
                <tr key={label}><td><kbd>{keys}</kbd></td><td>{label}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="ux-zoom-row">
            <button type="button" className="ux-button compact" onClick={() => onZoom("down")}>− Zoom out</button>
            <button type="button" className="ux-button compact" onClick={() => onZoom("reset")}>Reset zoom</button>
            <button type="button" className="ux-button compact" onClick={() => onZoom("up")}>+ Zoom in</button>
          </div>
        </div>
      </div>
    </div>
  );
}
