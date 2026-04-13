# Arena Browser — Obsidian Plugin

Browse your vault folders as **Are.na-style channels and blocks** with drag-and-drop organization.

## What it does

Turns any vault folder into an Are.na-like visual browser. Subfolders become *channels*, files inside them become *blocks*. Images render as thumbnails, markdown shows text previews, and everything else shows a filetype badge.

## Setup

```bash
# Clone into your vault's plugin directory
cd /path/to/vault/.obsidian/plugins/
git clone <repo-url> arena-browser
cd arena-browser

# Install and build
npm install
npm run build

# Or use dev mode (auto-rebuilds on change)
npm run dev
```

Then enable "Arena Browser" in Obsidian → Settings → Community Plugins.

## Usage

1. **Open**: Click the grid icon in the ribbon, or use Command Palette → "Open Arena browser"
2. **Create channels**: Click "+ New channel" or use Command Palette → "Create new channel"
3. **Add blocks**: Drag files from Finder/desktop directly into a channel view
4. **Move blocks**: Drag blocks between channels within the browser
5. **Open files**: Click any block to open it in Obsidian's editor
6. **Right-click**: Context menus on channels and blocks for additional actions

## Folder structure

```
vault/
└── arena/              ← root folder (configurable in settings)
    ├── design-resources/
    │   ├── _channel.md       ← channel metadata (auto-created)
    │   ├── screenshot.png
    │   ├── reference.pdf
    │   └── notes.md
    ├── gfx/
    │   ├── _channel.md
    │   ├── texture-01.png
    │   └── shader-notes.md
    └── websites/
        ├── _channel.md
        └── bookmarks.md
```

## Settings

- **Root folder**: Which vault folder contains your channels (default: `arena`)
- **Grid columns**: Number of columns in the grid layout (2–5)

## Roadmap

- URL bookmarks with Open Graph previews
- Cross-channel connections (blocks appearing in multiple channels)
- Tag system with filtering
- Search across all channels
- Masonry layout option
- Nested channels (sub-channels)
- Keyboard navigation

