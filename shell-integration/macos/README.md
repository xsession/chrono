# Finder integration (macOS)

Finder context-menu items are Automator **Quick Actions**:

1. Copy `../chrono-open` to `/usr/local/bin/chrono-open` (or `~/bin`) and make it executable.
2. Open **Automator** → *New Document* → **Quick Action**.
3. Set *Workflow receives current* **files or folders** in **Finder**.
4. Add **Run Shell Script**, set *Pass input* to **as arguments**, and enter:

   ```sh
   /usr/local/bin/chrono-open commit "$@"
   ```

5. Save as **Chrono — Commit**. Repeat with other actions from `../actions.tsv`
   (`log`, `diff`, `blame`, `revert`, `explore`, …).

The actions appear under right-click → **Quick Actions**. `chrono-open` starts
`/Applications/Chrono.app` with `--tgit=<action>`, or opens a `chrono://` link.
