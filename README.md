# Arena Browser

Browse your vault as [Are.na](https://www.are.na/)-style channels and blocks — a visual, drag-and-drop way to organize files and folders in Obsidian.

## Features

- Subfolders become **channels**, files inside them become **blocks**
- Images render as thumbnails, markdown files show text previews, everything else shows a filetype badge
- Drag files from Finder or your desktop directly into a channel
- Drag blocks between channels to reorganize
- Right-click channels and blocks for additional actions

## Installation

You can install the plugin via the Community Plugins tab within Obsidian. Search for "Arena Browser."

To install manually, copy `main.js`, `styles.css`, and `manifest.json` into your vault at `.obsidian/plugins/arena-browser/`, then enable the plugin in Settings → Community Plugins.

## Usage

After enabling the plugin, click the grid icon in the ribbon or use the Command Palette → **Open Arena browser**.

- **Create a channel**: Click **+ New channel** or use Command Palette → _Create new channel_
- **Add blocks**: Drag files from Finder or your desktop into a channel
- **Move blocks**: Drag blocks between channels in the browser
- **Open a file**: Click any block to open it in the editor

## Folder structure

Arena Browser maps directly to your vault's folder structure. By default it looks for a folder named `arena` at your vault root:

```
vault/
└── arena/
    ├── design-resources/
    │   ├── screenshot.png
    │   └── notes.md
    └── mood-board/
        └── reference.pdf
```

## Settings

- **Root folder**: The vault folder Arena Browser treats as its top level (default: `arena`)11
