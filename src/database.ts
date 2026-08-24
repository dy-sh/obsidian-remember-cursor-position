import { App, Notice } from 'obsidian';
import { EphemeralState, PluginSettings } from './types';

export type CursorDatabase = { [file_path: string]: EphemeralState };

// Hard cap on stored entries. Keeps the data file well under 100 KB regardless
// of vault size; trimming to 3/4 of the cap adds hysteresis so pruning does not
// churn on every write once the cap is reached.
const MAX_ENTRIES = 750;
const TRIM_TARGET = Math.floor(MAX_ENTRIES * 3 / 4);

// On-disk compact record, scroll first, length decides shape (no sentinels):
//   [scroll]                           -> no cursor (incl. a collapsed cursor at
//                                          (0,0), which is the editor default)
//   [scroll, line, ch]                 -> single-point cursor (from === to)
//   [scroll, line, ch, to.line, to.ch] -> selection
// A [0] record is a tombstone: nothing to restore, but its presence in the
// in-memory db marks the file as visited for the rest of the session, so the
// defaultPosition setting does not kick in again. Tombstones are never
// persisted: on disk they would be indistinguishable from "never visited",
// and defaultPosition only matters for a file's first open anyway.
// Restore only scrolls when scroll > 0, so scroll <= 0 acts as "don't scroll".
function encodeValue(st: EphemeralState): number[] {
	const scroll = st.scroll ?? 0;
	if (!st.cursor)
		return [scroll];
	const { from, to } = st.cursor;
	if (from.line === to.line && from.ch === to.ch)
		return [scroll, from.line, from.ch];
	return [scroll, from.line, from.ch, to.line, to.ch];
}

function decodeValue(arr: number[]): EphemeralState {
	const st: EphemeralState = {};

	if (arr[0] > 0)
		st.scroll = arr[0];

	if (arr.length >= 5) {
		st.cursor = {
			from: { line: arr[1], ch: arr[2] },
			to: { line: arr[3], ch: arr[4] },
		};
	} else if (arr.length === 3) {
		const p = { line: arr[1], ch: arr[2] };
		st.cursor = { from: p, to: p };
	}
	return st;
}

export class CursorPositionDatabase {
	db: CursorDatabase = {};
	dbDirty: boolean = false;

	// Tracks the last key in insertion order. Used so setState() can skip the
	// delete+insert (which moves a key to the end to mark it fresh) when the key
	// is already the most recently touched one — i.e. while editing one file.
	private lastKey: string | null = null;

	private app: App;
	private manifestDir: string;
	private settings: PluginSettings;

	constructor(
		app: App,
		manifestDir: string,
		settings: PluginSettings
	) {
		this.app = app;
		this.manifestDir = manifestDir;
		this.settings = settings;
	}

	get defaultDbFileName(): string {
		return this.manifestDir + '/cursor-positions.json';
	}

	private getDbPath(): string {
		return this.settings.dbFileName || this.defaultDbFileName;
	}

	// Ensures the parent folder of the configured db path exists. If it can't
	// be created, falls back to the default path (manifest folder) and notifies
	// the user.
	// @returns true if the configured path is usable unchanged; false if the
	//          setting was changed to the default (callers should save settings).
	async ensureDbFolder(): Promise<boolean> {
		const dbPath = this.getDbPath();
		const parentFolder = dbPath.substring(0, dbPath.lastIndexOf("/"));

		// No parent folder (e.g. default path in manifest root) — nothing to create.
		if (!parentFolder)
			return true;

		try {
			if (!(await this.app.vault.adapter.exists(parentFolder)))
				await this.app.vault.adapter.mkdir(parentFolder);
			return true;
		} catch (e) {
			console.error(
				"Remember Cursor Position plugin can't create db folder: " + e
			);
			this.settings.dbFileName = '';
			new Notice(
				"Cannot create data file folder, using default: " + this.defaultDbFileName
			);
			return false;
		}
	}

	//----------------------------------------------------------------------------------------

	pruneDb(): number {
		const beforeLength = Object.keys(this.db).length;

		this.removeExcludedFolders();

		this.trimToLimit();

		const removed = beforeLength - Object.keys(this.db).length;
		if (removed > 0) this.dbDirty = true;
		return removed;
	}

	// Always drop records for files in excluded folders: restore does not
	// check exclusions, so stale records there would wrongly re-position.
	private removeExcludedFolders(): void {
		const excludedFolders = this.settings.excludedFolders;
		if (excludedFolders.length === 0)
			return;
		for (const key of Object.keys(this.db)) {
			if (excludedFolders.some((folder) =>
				key === folder || key.startsWith(folder + '/')
			)) {
				delete this.db[key];
			}
		}
	}

	// Record a position for fileName. If the key is already the most recently
	// touched (lastKey), overwrite in place — no delete+insert, which would
	// needlessly churn the V8 object shape. Otherwise delete+insert to move it
	// to the end of insertion order, so trimToLimit keeps it as "fresh".
	setState(fileName: string, st: EphemeralState): void {
		const existed = this.db[fileName] !== undefined;
		if (existed && fileName === this.lastKey) {
			this.db[fileName] = st;
		} else {
			if (existed) delete this.db[fileName];
			this.db[fileName] = st;
			this.lastKey = fileName;
		}
		this.dbDirty = true;
	}

	// If the database exceeds MAX_ENTRIES, drops the oldest entries down to
	// TRIM_TARGET (3/4 of the cap) to add hysteresis. Recency is the insertion
	// order: setState() always moves a touched key to the end, so the tail holds
	// the most-recently-modified files. Keeping the tail is equivalent to the
	// old lastModified-based LRU but needs no timestamp.
	private trimToLimit(): void {
		if (Object.keys(this.db).length <= MAX_ENTRIES)
			return;

		const entries = Object.entries(this.db);
		const kept = entries.slice(entries.length - TRIM_TARGET);
		this.db = Object.fromEntries(kept);
	}

	async readDb(): Promise<void> {
		let db: CursorDatabase = {}

		try {
			if (await this.app.vault.adapter.exists(this.getDbPath())) {
				let data = await this.app.vault.adapter.read(this.getDbPath());
				const raw = JSON.parse(data);
				
				// Decide once, before the loops, whether this file is in the new
				// compact format or the legacy object format. The whole file is
				// written in a single format, so the first entry is representative.
				const keys = Object.keys(raw);
				const isCompact = keys.length > 0 && Array.isArray(raw[keys[0]]);

				if (isCompact) {
					// Compact on-disk format.
					for (const key of keys) {
						db[key] = decodeValue(raw[key]);
					}
				} else {
					// Legacy object format (migrated to compact on next write).
					// Sort by lastModified (oldest → newest) so insertion order
					// reflects recency — the compact format relies on that order
					// for trimming, so we must rebuild it instead of copying in
					// arbitrary JSON order.
					const lastModified = (st: unknown) =>
						(st as { lastModified?: number }).lastModified ?? 0;
					keys.sort((a, b) => lastModified(raw[a]) - lastModified(raw[b]));
					for (const key of keys) {
						db[key] = raw[key] as EphemeralState;
					}
					// Migrate to compact format on the next flush.
					this.dbDirty = true;
				}
			}
		} catch (e) {
			console.error("Remember Cursor Position plugin can't read database: " + e);
			db = {};
		}

		this.db = db;
	}

	async writeDb() {
		if (!this.dbDirty) return;

		// Keep the file bounded even across long sessions (pruning also runs on
		// startup); no-op unless the cap is exceeded.
		this.trimToLimit();

		const encoded: { [path: string]: number[] } = {};
		for (const key of Object.keys(this.db)) {
			const st = this.db[key];
			// Skip empty records (no cursor, no positive scroll): restoring
			// them is a no-op, same as having no record at all. The only thing
			// they would preserve is "this file was already visited" for
			// defaultPosition — not worth dead entries on disk.
			if (!st.cursor && (st.scroll ?? 0) <= 0)
				continue;
			encoded[key] = encodeValue(st);
		}
		const data = JSON.stringify(encoded);
		const dbPath = this.getDbPath();

		try {
			// Fast path: the folder (almost always) already exists.
			await this.app.vault.adapter.write(dbPath, data);
		} catch (e) {
			// Slow path: folder likely missing — ensure it (or fall back to the
			// default path) and retry once.
			await this.ensureDbFolder();
			try {
				await this.app.vault.adapter.write(this.getDbPath(), data);
			} catch (e2) {
				console.error(
					"Remember Cursor Position plugin can't write database: " + e2
				);
				return;
			}
		}

		this.dbDirty = false;
	}

	renameFile(file: { path: string }, oldPath: string) {
		if (!this.db[oldPath])
			return;
		this.db[file.path] = this.db[oldPath];
		delete this.db[oldPath];
		this.dbDirty = true;
	}

	deleteFile(file: { path: string }) {
		if (!this.db[file.path])
			return;
		delete this.db[file.path];
		this.dbDirty = true;
	}
}
