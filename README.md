# Remember Cursor Position

An [Obsidian](https://obsidian.md/) plugin that remembers the cursor position, scroll position, and text selection for each note.

## Features

- **Cursor position** — returns to the exact line and column you were editing
- **Scroll position** — restores where you were scrolled to in the document
- **Text selection** — preserves any selected text when reopening a note
- **Edit & Preview modes** — works in both editing and reading views
- **Persistent storage** — positions are saved to a JSON file (configurable path) and survive app restarts
- **Smart restoration** — avoids unwanted scrolling when opening links that target a specific section (`#header` links)
- **Configurable defaults** — choose what happens when no saved position exists: go to beginning, end, before footnotes, or do nothing
- **Pruning** — optionally remove entries for deleted files, old entries by age, or cap the total number of stored positions

## How it works

Each time you move the cursor or scroll in a note, the plugin records that state. When you come back to the same note (even after closing and reopening Obsidian), it restores your exact position and selection. This makes navigating between notes seamless — no more manually scrolling to find your place.

## Installation

### From Obsidian Community Plugins

1. Open **Settings** → **Community plugins**
2. Disable **Restricted mode** (if enabled)
3. Click **Browse** and search for "Remember Cursor Position"
4. Install and enable the plugin

### Manual installation

1. Download the latest release from the [releases page](https://github.com/dy-sh/obsidian-remember-cursor-position/releases)
2. Extract the files into your vault's `.obsidian/plugins/remember-cursor-position/` directory
3. Enable the plugin in **Settings** → **Community plugins**

## Settings

| Setting | Description |
|---------|-------------|
| Default cursor position | What to do when no saved position exists for a file (Beginning / End / Before footnotes / Default — do nothing) |
| Data file name | Path to the JSON file where positions are stored |
| Delay after opening a new note | Prevents unwanted scrolling when opening links with section anchors |
| Delay between saving | How often the position database is written to disk |
| Remove entries for deleted files | Prune positions for files that no longer exist in the vault |
| Remove entries older than | Automatically discard positions not updated within the selected period |
| Maximum number of entries to keep | Limit the database size by keeping only the most recently visited files |

## Support

If you find a bug or have a feature request, please [open an issue](https://github.com/dy-sh/obsidian-remember-cursor-position/issues).
