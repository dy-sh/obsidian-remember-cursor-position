# Remember Cursor Position

An [Obsidian](https://obsidian.md/) plugin that remembers the cursor position, scroll position, and text selection for each note.

## Features

- **Cursor position** — returns to the exact line and column you were editing
- **Scroll position** — restores where you were scrolled to in the document
- **Text selection** — preserves any selected text when reopening a note
- **Edit & Preview modes** — works in both editing (source) and reading (preview) views
- **Native-looking restore** — the saved position is applied in the same pipeline slot Obsidian uses for its own restore, so reopening a note looks indistinguishable from a native open
- **Flicker-free in source mode** — the cursor/scroll are injected synchronously into the open, so the editor paints directly at your position with no top-first flash
- **No top flash in reading mode** — the note is hidden before the async render paints the top, then revealed only in the frame the restored scroll is confirmed landed
- **Persistent storage** — positions are saved to a JSON file (configurable path) and survive app restarts
- **Smart restoration** — yields to link targets, so opening a section link (`note.md#header` or `note.md^block`) scrolls to the heading/block instead of the saved position
- **Configurable defaults** — choose what happens when no saved position exists: Obsidian's default, jump to the end, or land just before the footnotes
- **Compact on-disk format** — each record is a compact numeric array (`[scroll]`, `[scroll, line, ch]`, or `[scroll, line, ch, to.line, to.ch]`), empty records are never written, and the whole file stays well under 100 KB regardless of vault size
- **Bounded database (750 entries)** — the database is capped at 750 entries; once exceeded it trims to 3/4 of the cap, evicting the least-recently-visited files first so the cap never churns on every write
- **Minimum length filter** — optionally skip remembering positions for short files (e.g. scratch notes) to keep the database clean
- **Excluded folders** — skip remembering positions for files in selected folders (and their subfolders)
- **Performance-conscious** — a 100 ms polling loop with deduped writes, an LRU-ordered in-memory map, memoized exclusion checks, and rAF-bounded restore loops keep steady-state cost negligible even in large vaults

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
| Default cursor position | What to do when no saved position exists for a file. Options: **Default** (Obsidian's default), **End**, or **Before footnotes**. Note: "End" and "Before footnotes" only apply in source mode; in reading view the default position is used instead. |
| Data file path | Full path to the JSON file where positions are stored; leave empty to use the default path (only files inside the vault are supported). |
| Delay between saving the cursor position to file | How often the position database is written to disk. Useful for multi-device setups where you don't want to wait until closing Obsidian for a position to be saved. |
| Do not record files shorter than | Skip remembering cursor/scroll position for files with fewer lines than this value; `0` disables the filter. |
| Excluded folders | Skip remembering cursor/scroll position for files in the selected folders and their subfolders; saved positions for those files are removed automatically on startup and the next time they are opened. |
| Stored positions | Displays how many entries are currently tracked; the database is capped at 750 entries and kept small automatically, removing the least-recently-visited files first. |

## Support

If you find a bug or have a feature request, please [open an issue](https://github.com/dy-sh/obsidian-remember-cursor-position/issues).
