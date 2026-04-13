# ⬛ Pixel Branch Diff Explorer

> A cute retro pixel UI for exploring git branch changes — right inside the VS Code Explorer panel.

---

## ✨ Features

- **Explorer panel integration** — lives at the bottom of your Explorer sidebar, always visible
- **Two diff modes** — compare vs a base branch (`main`) or view working tree changes
- **Inline diff viewer** — GitHub-style side-annotated diff rendered inside the webview (no new tabs!)
- **Extension filter pills** — filter files by `ASTRO`, `JS`, `CSS`, `SVG`, `IMG`, `ETC`
- **File actions** — `OPEN`, `DIFF`, `PIN` on every file
- **Retro pixel UI** — chunky borders, pixel mascot, dot-grid accent, theme-aware colors
- **Smart error handling** — handles deleted, renamed, added, and missing files gracefully
- **Auto-refresh** — watches `.git/index` for changes

---

## 🚀 Getting Started

### Install from source

```bash
git clone <this-repo>
cd pixel-branch-diff-explorer
npm install   # no runtime deps — just devDependencies for linting
```

Open in VS Code:

```bash
code .
```

Press **F5** to launch the Extension Development Host.

---

## 🎛 Commands

| Command | Description |
|---|---|
| `Pixel Diff: Refresh` | Re-run git and reload the file list |
| `Pixel Diff: Set Base Branch` | Change the base branch (default: `main`) |
| `Pixel Diff: Toggle Mode` | Switch between `compareBase` and `workingTree` |

All commands are available via the Command Palette (`Ctrl/Cmd + Shift + P`).

The **↺ SYNC** button and **⇄ MODE** button in the panel header also trigger these.

---

## ⚙️ Configuration

| Setting | Default | Description |
|---|---|---|
| `pixelBranchDiff.baseBranch` | `"main"` | Base branch to compare against |
| `pixelBranchDiff.mode` | `"compareBase"` | `"compareBase"` or `"workingTree"` |

Set these in your workspace's `.vscode/settings.json`:

```json
{
  "pixelBranchDiff.baseBranch": "develop",
  "pixelBranchDiff.mode": "compareBase"
}
```

---

## 🎨 UI Overview

```
┌─────────────────────────────────────────────────┐
│ ON [branch-name]  vs branch  vs [main]  ⇄ ↺    │ ← toolbar
│ [ALL][ASTRO][JS][CSS][SVG][IMG][ETC]            │ ← filter pills
├────────────────────────────────────────────────┤
│ 🟦 pixel mascot   tracking changes…  3 files   │ ← mascot bar
├──────────────────┬─────────────────────────────┤
│ ~ src/index.js   │ BASE → HEAD                 │
│   ↗ OPEN ≠ DIFF │ @@ -12 +14 @@               │
│ + styles/new.css │   function foo() {           │
│ ✕ old/gone.ts   │ - return null;               │
│                  │ + return true;               │
│                  │ }                            │
└──────────────────┴─────────────────────────────┘
```

- **Left panel**: filter pills + mascot + scrollable file list
- **Right panel**: inline diff with line numbers, `+` / `-` signs, and colored rows

---

## 🔧 Git Commands Used

**compareBase mode:**
```bash
git diff --name-status <base>...HEAD
git show <base>:<file>
git show HEAD:<file>
```

**workingTree mode:**
```bash
git status --porcelain
git show HEAD:<file>
cat <file>   # for untracked files
```

---

## 📁 File Structure

```
pixel-branch-diff-explorer/
├── extension.js      # Main extension + WebviewViewProvider + git logic
├── package.json      # Extension manifest
└── README.md         # This file
```

No bundler. No React. No external runtime dependencies. Pure vanilla JS webview.

---

## 🐛 Error Handling

The extension handles:
- Not a git repo → shows error message in panel
- No workspace open → friendly prompt
- Deleted files → shows base content only
- Renamed files → diffs old path vs new path
- New/untracked files → shows head content only
- Missing files → shows partial diff with error note
- Binary files → shows "No textual changes" notice

---

## 🎨 Theme Support

All colors use VS Code theme tokens — works with any light or dark theme:

- `--vscode-editor-background / foreground`
- `--vscode-panel-border`
- `--vscode-button-background / foreground`
- `--vscode-textLink-foreground` (accent)
- `--vscode-diffEditor-insertedLineBackground`
- `--vscode-diffEditor-removedLineBackground`
- `--vscode-badge-background / foreground`
- `--vscode-list-hoverBackground`

---

## 📜 License

MIT
