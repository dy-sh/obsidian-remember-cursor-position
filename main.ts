import { App, Plugin, PluginSettingTab, SettingGroup, MarkdownView, TAbstractFile, Editor, TFile, Notice, TextComponent } from 'obsidian';

type DefaultPosition = 'beginning' | 'end' | 'default' | 'beforeFootnotes';

interface PluginSettings {
	dbFileName: string;
	delayAfterFileOpening: number;
	saveTimer: number;
	pruneOrphans: boolean;
	maxAgeDays: number;   // 0 = disabled
	maxCount: number;     // 0 = disabled
	defaultPosition: DefaultPosition;
	skipRestoreFromSearch: boolean;
	restorePositionOnWorkspaceLoad: boolean;
	excludedFiles: string[];
}

const SAFE_DB_FLUSH_INTERVAL = 5000;

const DEFAULT_DB_FILENAME_LEGACY = '.obsidian/plugins/remember-cursor-position/cursor-positions.json';

const DEFAULT_SETTINGS: PluginSettings = {
	dbFileName: '',
	delayAfterFileOpening: 100,
	saveTimer: SAFE_DB_FLUSH_INTERVAL,
	pruneOrphans: false,
	maxAgeDays: 0,
	maxCount: 0,
	defaultPosition: 'default',
	skipRestoreFromSearch: false,
	restorePositionOnWorkspaceLoad: true,
	excludedFiles: [],
};

// Skip re-restoring the same (leaf, file) combination within this window.
// It keeps the "don't jump the cursor when a document is already open" intent
// without blocking restoration on startup or when a workspace is loaded.
const RESTORE_GUARD_WINDOW_MS = 1500;

// Delay after the layout is ready before forcing a restore of the active file.
const LAYOUT_READY_RESTORE_DELAY = 600;

// Window during which a detected workspace load suppresses position restoration
// when the "restore on workspace load" option is disabled.
const WORKSPACE_LOAD_WINDOW_MS = 3000;

// Debounce for workspace layout change handling.
const LAYOUT_CHANGE_DEBOUNCE_MS = 250;

function globToRegex(glob: string): RegExp {
	let pattern = glob.trim().replace(/\\/g, '/');
	let folderOnly = false;
	if (pattern.endsWith('/')) {
		folderOnly = true;
		pattern = pattern.slice(0, -1);
	}
	let re = '';
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				i++;
				if (pattern[i + 1] === '/') {
					// "**/" matches zero or more path segments
					i++;
					re += '(?:.*/)?';
				} else {
					re += '.*';
				}
			} else {
				re += '[^/]*';
			}
		} else if (c === '?') {
			re += '[^/]';
		} else {
			re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}
	}
	if (folderOnly) {
		return new RegExp('^' + re + '(?:/.*)?$');
	}
	return new RegExp('^' + re + '$');
}

interface EphemeralState {
	cursor?: {
		from: {
			ch: number
			line: number
		},
		to: {
			ch: number
			line: number
		}
	},
	scroll?: number,
	lastModified?: number
}


export default class RememberCursorPosition extends Plugin {
	settings: PluginSettings;
	db: { [file_path: string]: EphemeralState };
	lastSavedDb: { [file_path: string]: EphemeralState };
	lastEphemeralState: EphemeralState;
	lastLoadedFileName: string;
	lastRestoredLeafFile = '';
	lastRestoredAt = 0;
	loadingFile = false;
	saveTimerIntervalId: number;
	layoutChangeTimer: number;
	lastKnownMarkdownFiles: Set<string> = new Set();
	workspaceLoadUntil = 0;
	pendingWorkspaceRestore = false;
	excludedPatterns: RegExp[] = [];
	excludedPatternsCache = '';

	async onload() {
		await this.loadSettings();

		try {
			this.db = await this.readDb();
			this.pruneDb();
			this.lastSavedDb = await this.readDb();
		} catch (e) {
			console.error(
				"Remember Cursor Position plugin can\'t read database: " + e
			);
			this.db = {};
			this.lastSavedDb = {};
		}

		this.addSettingTab(new SettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => this.restoreEphemeralState(file))
		);

		this.registerEvent(
			this.app.workspace.on('layout-change', () => this.onLayoutChanged())
		);


		this.registerEvent(
			this.app.workspace.on('quit', () => { this.writeDb(this.db) }),
		);


		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => this.renameFile(file, oldPath)),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => this.deleteFile(file)),
		);

		//todo: replace by scroll and mouse cursor move events
		this.registerInterval(
			window.setInterval(() => this.checkEphemeralStateChanged(), 100)
		);

		this.saveTimerIntervalId = this.registerInterval(
			window.setInterval(() => this.writeDb(this.db), this.settings.saveTimer)
		);

		this.app.workspace.onLayoutReady(() => {
			window.setTimeout(() => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return;
				const leaf = this.app.workspace.getMostRecentLeaf();
				//@ts-ignore no-official-API
				const leafId = leaf ? leaf.id : '';
				//@ts-ignore no-official-API
				const leafFile = leaf ? (leaf.getViewState().state as any)?.file : '';
				const guardKey = leafId + ':' + leafFile;
				if (this.lastRestoredLeafFile !== guardKey) {
					this.restoreEphemeralState();
				}
			}, LAYOUT_READY_RESTORE_DELAY);
		});

		this.restoreEphemeralState();
	}

	onunload() {
		window.clearTimeout(this.layoutChangeTimer);
	}

	renameFile(file: TAbstractFile, oldPath: string) {
		let newName = file.path;
		let oldName = oldPath;
		this.db[newName] = this.db[oldName];
		delete this.db[oldName];
	}


	deleteFile(file: TAbstractFile) {
		let fileName = file.path;
		delete this.db[fileName];
	}

	private compileExcludedPatterns() {
		this.excludedPatterns = (this.settings.excludedFiles || [])
			.map((pattern) => {
				const trimmed = pattern.trim();
				if (!trimmed) return null;
				try {
					return globToRegex(trimmed);
				} catch (e) {
					console.error("Remember Cursor Position plugin: invalid exclusion pattern \"" + trimmed + "\": " + e);
					return null;
				}
			})
			.filter((re): re is RegExp => re !== null);
	}

	isExcluded(filePath: string): boolean {
		if (!this.settings.excludedFiles || this.settings.excludedFiles.length === 0)
			return false;
		const cacheKey = JSON.stringify(this.settings.excludedFiles);
		if (cacheKey !== this.excludedPatternsCache) {
			this.compileExcludedPatterns();
			this.excludedPatternsCache = cacheKey;
		}
		return this.excludedPatterns.some((re) => re.test(filePath));
	}

	private hasSearchMatchInActiveLeaf(): boolean {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return false;
		const leaf = view.leaf;
		if (!leaf) return false;
		const eState = leaf.getEphemeralState() as Record<string, unknown> | undefined;
		if (eState && eState['match'] != null) return true;
		const state = leaf.getViewState().state as Record<string, unknown> | undefined;
		if (state && state['match'] != null) return true;
		return false;
	}

	private getOpenMarkdownFiles(): Set<string> {
		const files = new Set<string>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.getViewState().type === 'markdown') {
				const file = (leaf.getViewState().state as any)?.file;
				if (file) files.add(file);
			}
		});
		return files;
	}

	private onLayoutChanged() {
		const current = this.getOpenMarkdownFiles();
		const added = [...current].filter((f) => !this.lastKnownMarkdownFiles.has(f));
		const removed = [...this.lastKnownMarkdownFiles].filter((f) => !current.has(f));
		this.lastKnownMarkdownFiles = current;

		// A workspace load swaps the whole layout at once: several files are opened
		// and/or closed in a single change. A normal open/close touches one file.
		// Set the window immediately so file-opens that follow the layout change are
		// suppressed when the "restore on workspace load" option is disabled.
		if (added.length >= 2 || removed.length >= 2) {
			this.workspaceLoadUntil = Date.now() + WORKSPACE_LOAD_WINDOW_MS;
			this.pendingWorkspaceRestore = true;
		}

		// When the option is enabled, wait for the layout to settle, then restore the
		// active file once. This catches files that were opened by the workspace load
		// but were not restored through the regular file-open path.
		window.clearTimeout(this.layoutChangeTimer);
		this.layoutChangeTimer = window.setTimeout(() => {
			if (this.pendingWorkspaceRestore) {
				this.pendingWorkspaceRestore = false;
				if (this.settings.restorePositionOnWorkspaceLoad && this.app.workspace.getActiveFile()) {
					this.restoreEphemeralState();
				}
			}
		}, LAYOUT_CHANGE_DEBOUNCE_MS);
	}


	checkEphemeralStateChanged() {
		let fileName = this.app.workspace.getActiveFile()?.path;

		//waiting for load new file
		if (!fileName || !this.lastLoadedFileName || fileName != this.lastLoadedFileName || this.loadingFile)
			return;

		let st = this.getEphemeralState();

		let hadPriorState = this.lastEphemeralState && Object.keys(this.lastEphemeralState).length > 0;

		if (!this.lastEphemeralState)
			this.lastEphemeralState = st;

		if (!isNaN(st.scroll) && (!hadPriorState || !this.isEphemeralStatesEquals(st, this.lastEphemeralState))) {
			this.saveEphemeralState(st);
			this.lastEphemeralState = st;
		}
	}

	isEphemeralStatesEquals(state1: EphemeralState, state2: EphemeralState): boolean {
		if (state1.cursor && !state2.cursor)
			return false;

		if (!state1.cursor && state2.cursor)
			return false;

		if (state1.cursor) {
			if (state1.cursor.from.ch != state2.cursor.from.ch)
				return false;
			if (state1.cursor.from.line != state2.cursor.from.line)
				return false;
			if (state1.cursor.to.ch != state2.cursor.to.ch)
				return false;
			if (state1.cursor.to.line != state2.cursor.to.line)
				return false;
		}

		if (state1.scroll && !state2.scroll)
			return false;

		if (!state1.scroll && state2.scroll)
			return false;

		if (state1.scroll && state1.scroll != state2.scroll)
			return false;

		return true;
	}


	async saveEphemeralState(st: EphemeralState) {
		let fileName = this.app.workspace.getActiveFile()?.path;
		if (fileName && fileName == this.lastLoadedFileName) { //do not save if file changed or was not loaded
			if (this.isExcluded(fileName)) return;
			this.db[fileName] = { ...st, lastModified: Date.now() };
		}
	}


	async restoreEphemeralState(file?: TFile) {
		let fileName = this.app.workspace.getActiveFile()?.path;

		if (fileName && this.loadingFile && this.lastLoadedFileName == fileName) //if already started loading
			return;

		// When a workspace is loaded and the user disabled workspace restoration,
		// skip restoring positions during the load window.
		if (this.workspaceLoadUntil > Date.now() && !this.settings.restorePositionOnWorkspaceLoad)
			return;

		// Narrowed guard: skip only the same (leaf, file) combination restored very
		// recently. The old guard skipped every currently open leaf, which blocked
		// startup/workspace restoration (notes left open at quit were never restored).
		let activeLeaf = this.app.workspace.getMostRecentLeaf()
		//@ts-ignore no-official-API
		const leafId = activeLeaf ? activeLeaf.id : '';
		//@ts-ignore no-official-API
		const leafFile = activeLeaf ? (activeLeaf.getViewState().state as any)?.file : '';
		const guardKey = leafId + ':' + leafFile;
		if (fileName && this.lastRestoredLeafFile === guardKey && Date.now() - this.lastRestoredAt < RESTORE_GUARD_WINDOW_MS)
			return;

		this.loadingFile = true;

		if (this.lastLoadedFileName != fileName) {
			this.lastEphemeralState = {}
			this.lastLoadedFileName = fileName;

			let st: EphemeralState = {}

			if (fileName && !this.isExcluded(fileName)) {
				st = this.db[fileName];

				// When the note was opened from a search result, Obsidian already
				// jumped to the first match. If the user enabled the option, keep that
				// position instead of restoring the saved one.
				const openedFromSearch = this.settings.skipRestoreFromSearch && this.hasSearchMatchInActiveLeaf();

				if (st) {
					//waiting for load note
					await this.delay(this.settings.delayAfterFileOpening)

					// Don't scroll when a link scrolls and highlights text
					// i.e. if file is open by links like [link](note.md#header) and wikilinks
					// See #10, #32, #46, #51
					let containsFlashingSpan = this.app.workspace.containerEl.querySelector('.is-flashing');

					if (!containsFlashingSpan && !openedFromSearch) {
						await this.delay(10)
						this.setEphemeralState(st);
					}
				} else if (this.settings.defaultPosition !== 'default') {
					await this.delay(this.settings.delayAfterFileOpening)

					let containsFlashingSpan = this.app.workspace.containerEl.querySelector('.is-flashing');

					if (!containsFlashingSpan && !openedFromSearch) {
						await this.delay(10)
						if (this.settings.defaultPosition === 'beginning') {
							await this.setCursorToBeginning(file || this.app.workspace.getActiveFile());
						} else if (this.settings.defaultPosition === 'end') {
							this.setCursorToEnd();
						} else if (this.settings.defaultPosition === 'beforeFootnotes') {
							await this.setCursorToBeforeFootnotes(file || this.app.workspace.getActiveFile());
						}
					}
				}

				// Only register the "already restored" state when the file name is
				// non-empty, so the workspace-not-ready no-op call does not consume
				// the dedup window and block the file-open that follows.
				this.lastRestoredLeafFile = guardKey;
				this.lastRestoredAt = Date.now();
			}

			this.lastEphemeralState = st;
		}

		this.loadingFile = false;
	}

	pruneDb() {
		const { pruneOrphans, maxAgeDays, maxCount } = this.settings;

		if (pruneOrphans) {
			for (const key of Object.keys(this.db)) {
				if (!this.app.vault.getAbstractFileByPath(key)) {
					delete this.db[key];
				}
			}
		}

		if (maxAgeDays > 0) {
			const cutoff = Date.now() - maxAgeDays * 86400000;
			for (const key of Object.keys(this.db)) {
				if ((this.db[key].lastModified ?? 0) < cutoff) {
					delete this.db[key];
				}
			}
		}

		if (maxCount > 0 && Object.keys(this.db).length > maxCount) {
			const sorted = Object.entries(this.db)
				.sort((a, b) => (b[1].lastModified ?? 0) - (a[1].lastModified ?? 0));
			this.db = Object.fromEntries(sorted.slice(0, maxCount));
		}
	}

	async readDb(): Promise<{ [file_path: string]: EphemeralState; }> {
		let db: { [file_path: string]: EphemeralState; } = {}

		if (await this.app.vault.adapter.exists(this.settings.dbFileName)) {
			let data = await this.app.vault.adapter.read(this.settings.dbFileName);
			db = JSON.parse(data);
			const now = Date.now();
			for (const key of Object.keys(db)) {
				if (db[key].lastModified === undefined) {
					db[key].lastModified = now;
				}
			}
		}

		return db;
	}

	async writeDb(db: { [file_path: string]: EphemeralState; }) {
		//create folder for db file if not exist
		let newParentFolder = this.settings.dbFileName.substring(0, this.settings.dbFileName.lastIndexOf("/"));
		if (!(await this.app.vault.adapter.exists(newParentFolder)))
			this.app.vault.adapter.mkdir(newParentFolder);

		if (JSON.stringify(this.db) !== JSON.stringify(this.lastSavedDb)) {
			this.app.vault.adapter.write(
				this.settings.dbFileName,
				JSON.stringify(db)
			);
			this.lastSavedDb = JSON.parse(JSON.stringify(db));
		}
	}



	getEphemeralState(): EphemeralState {
		// let state: EphemeralState = this.app.workspace.getActiveViewOfType(MarkdownView)?.getEphemeralState(); //doesn't work properly
		
		let state: EphemeralState = {};
		state.scroll = Number(this.app.workspace.getActiveViewOfType(MarkdownView)?.currentMode?.getScroll()?.toFixed(4));
		
		let editor = this.getEditor();
		if (editor) {
			let from = editor.getCursor("anchor");
			let to = editor.getCursor("head");
			if (from && to) {
				state.cursor = {
					from: {
						ch: from.ch,
						line: from.line
					},
					to: {
						ch: to.ch,
						line: to.line
					}
				}
			}
		}

		return state;
	}

	setEphemeralState(state: EphemeralState) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (state.cursor) {
			let editor = this.getEditor();
			if (editor) {
				editor.setSelection(state.cursor.from, state.cursor.to);
			}
		}

		if (view && state.scroll) {
			view.setEphemeralState(state);
			// view.previewMode.applyScroll(state.scroll);
			// view.sourceMode.applyScroll(state.scroll);
		}

		// Anchor the cursor line into view after the scroll is applied. This guards
		// against drift when dynamic content (e.g. Dataview tables) renders after the
		// restore and changes the document height.
		if (state.cursor) {
			let editor = this.getEditor();
			if (editor) {
				editor.scrollIntoView({ from: state.cursor.from, to: state.cursor.to }, true);
			}
		}
	}

	private async setCursorToBeginning(file: TFile) {
		let content = await this.app.vault.read(file);
		let lines = content.split('\n');
		let startLine = 0;
		if (lines.length > 0 && lines[0].trim() === '---') {
			for (let i = 1; i < lines.length; i++) {
				if (lines[i].trim() === '---') {
					startLine = i + 1;
					break;
				}
			}
		}
		let editor = this.getEditor();
		if (editor) {
			if (startLine >= editor.lineCount()) {
				startLine = Math.max(0, editor.lineCount() - 1);
			}
			editor.setCursor({ line: startLine, ch: 0 });
			editor.scrollIntoView({ from: { line: startLine, ch: 0 }, to: { line: startLine, ch: 0 } }, true);
		}
	}

	private setCursorToEnd() {
		let editor = this.getEditor();
		if (editor) {
			let lastLine = editor.lastLine();
			let lastLineLength = editor.getLine(lastLine).length;
			editor.setCursor({ line: lastLine, ch: lastLineLength });
			editor.scrollIntoView({ from: { line: lastLine, ch: 0 }, to: { line: lastLine, ch: lastLineLength } }, true);
		}
	}

	private async setCursorToBeforeFootnotes(file: TFile) {
		let content = await this.app.vault.read(file);
		let lines = content.split('\n');
		let footnoteLine = -1;
		for (let i = 0; i < lines.length; i++) {
			if (/^\s*\[\^[^\]]+\]:\s/.test(lines[i])) {
				footnoteLine = i;
				break;
			}
		}
		if (footnoteLine === -1) {
			this.setCursorToEnd();
			return;
		}
		let targetLine = footnoteLine - 1;
		while (targetLine >= 0 && lines[targetLine].trim() === '') {
			targetLine--;
		}
		if (targetLine < 0) {
			targetLine = 0;
		}
		let editor = this.getEditor();
		if (editor) {
			if (targetLine >= editor.lineCount()) {
				targetLine = Math.max(0, editor.lineCount() - 1);
			}
			let ch = editor.getLine(targetLine).length;
			editor.setCursor({ line: targetLine, ch: ch });
			editor.scrollIntoView({ from: { line: targetLine, ch: 0 }, to: { line: targetLine, ch: ch } }, true);
		}
	}

	private getEditor(): Editor {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
	}

	async loadSettings() {
		let settings: PluginSettings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		if (settings?.saveTimer < SAFE_DB_FLUSH_INTERVAL) {
			settings.saveTimer = SAFE_DB_FLUSH_INTERVAL;
		}
		if (!settings.dbFileName || settings.dbFileName === DEFAULT_DB_FILENAME_LEGACY) {
			settings.dbFileName = this.manifest.dir + '/cursor-positions.json';
		}
		this.settings = settings;
		this.compileExcludedPatterns();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.compileExcludedPatterns();
	}

	async delay(ms: number) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}



class SettingTab extends PluginSettingTab {
	plugin: RememberCursorPosition;
	requiredErrorTimer: number = 0;
	requiredErrorInput: HTMLInputElement | null = null;
	requiredErrorTooltip: HTMLElement | null = null;
	requiredErrorParent: HTMLElement | null = null;

	constructor(app: App, plugin: RememberCursorPosition) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private showRequiredError(input: TextComponent, message: string) {
		this.clearRequiredError();
		const inputEl = input.inputEl;
		inputEl.addClass('rcp-input-error');

		const tooltip = document.createElement('div');
		tooltip.addClass('rcp-validation-tooltip');
		tooltip.setText(message);
		const parent = inputEl.parentElement;
		if (parent) {
			parent.style.position = 'relative';
			tooltip.style.left = inputEl.offsetLeft + 'px';
			parent.appendChild(tooltip);
		}

		this.requiredErrorInput = inputEl;
		this.requiredErrorTooltip = tooltip;
		this.requiredErrorParent = parent;

		this.requiredErrorTimer = window.setTimeout(() => this.clearRequiredError(), 3000);

		inputEl.addEventListener('input', () => this.clearRequiredError(), { once: true });
		inputEl.addEventListener('blur', () => this.clearRequiredError(), { once: true });
	}

	private clearRequiredError() {
		window.clearTimeout(this.requiredErrorTimer);
		if (this.requiredErrorInput) {
			this.requiredErrorInput.removeClass('rcp-input-error');
			this.requiredErrorInput = null;
		}
		if (this.requiredErrorTooltip && this.requiredErrorTooltip.parentElement) {
			this.requiredErrorTooltip.parentElement.removeChild(this.requiredErrorTooltip);
		}
		this.requiredErrorTooltip = null;
		if (this.requiredErrorParent) {
			this.requiredErrorParent.style.position = '';
			this.requiredErrorParent = null;
		}
	}

	private addExclusion(addText: TextComponent | null) {
		const value = addText ? addText.getValue().trim() : '';
		if (!value) {
			if (addText) this.showRequiredError(addText, 'Path is required.');
			return;
		}
		this.plugin.settings.excludedFiles.push(value);
		this.plugin.saveSettings().then(() => this.display());
	}

	private getScrollContainer(): HTMLElement | null {
		let node: HTMLElement | null = this.containerEl;
		while (node) {
			const overflowY = window.getComputedStyle(node).overflowY;
			if (overflowY === 'auto' || overflowY === 'scroll') {
				return node;
			}
			node = node.parentElement;
		}
		return null;
	}

	display(): void {
		let { containerEl } = this;

		// Preserve the scroll position across re-renders so that updates to
		// settings (e.g. adding/removing exclusions) don't reset the viewport.
		const scrollContainer = this.getScrollContainer();
		const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

		containerEl.empty();
		this.clearRequiredError();

		new SettingGroup(containerEl)
			.addSetting((setting) =>
				setting
					.setName('Default cursor position')
					.setDesc(
						'When no saved position exists for a file, jump to this position. "Default" means do nothing.'
					)
					.addDropdown((drop) =>
						drop
							.addOption('beginning', 'Beginning')
							.addOption('end', 'End')
							.addOption('beforeFootnotes', 'Before footnotes')
							.addOption('default', 'Default (do nothing)')
							.setValue(this.plugin.settings.defaultPosition)
							.onChange(async (value) => {
								this.plugin.settings.defaultPosition = value as DefaultPosition;
								await this.plugin.saveSettings();
							})
					)
			)
			.addSetting((setting) =>
				setting
					.setName('Skip restoring position when opening from a search result')
					.setDesc(
						'When enabled, opening a note from a search result jumps to the match instead of the saved cursor position. ' +
						'When disabled, the saved position is restored as usual.'
					)
					.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.skipRestoreFromSearch)
							.onChange(async (value) => {
								this.plugin.settings.skipRestoreFromSearch = value;
								await this.plugin.saveSettings();
							})
					)
			)
			.addSetting((setting) =>
				setting
					.setName('Restore position when loading a workspace')
					.setDesc(
						'When enabled, notes opened by loading a workspace (Workspaces core plugin) restore their saved position, ' +
						'or the configured default position when no position is saved. When disabled, they open at the top.'
					)
					.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.restorePositionOnWorkspaceLoad)
							.onChange(async (value) => {
								this.plugin.settings.restorePositionOnWorkspaceLoad = value;
								await this.plugin.saveSettings();
							})
					)
			)
			.addSetting((setting) =>
				setting
					.setName('Data file name')
					.setDesc('Save positions to this file')
					.addText((text) =>
						text
							.setPlaceholder('Example: cursor-positions.json')
							.setValue(this.plugin.settings.dbFileName)
							.onChange(async (value) => {
								this.plugin.settings.dbFileName = value;
								await this.plugin.saveSettings();
							})
					)
			)
			.addSetting((setting) =>
				setting
					.setName('Delay after opening a new note')
					.setDesc(
						"This plugin shouldn't scroll if you used a link to the note header like [link](note.md#header). If it did, then increase the delay until everything works. If you are not using links to page sections, set the delay to zero (slider to the left). Slider values: 0-300 ms (default value: 100 ms)."
					)
					.addSlider((text) =>
						text
							.setLimits(0, 300, 10)
							.setDynamicTooltip()
							.setValue(this.plugin.settings.delayAfterFileOpening)
							.onChange(async (value) => {
								this.plugin.settings.delayAfterFileOpening = value;
								await this.plugin.saveSettings();
							})
					)
			)
			.addSetting((setting) =>
				setting
					.setName('Delay between saving the cursor position to file')
					.setDesc(
						"Useful for multi-device users. If you don't want to wait until closing Obsidian to the cursor position been saved."
					)
					.addSlider((text) =>
						text
							.setLimits(SAFE_DB_FLUSH_INTERVAL, SAFE_DB_FLUSH_INTERVAL * 10, 10)
							.setDynamicTooltip()
							.setValue(this.plugin.settings.saveTimer)
							.onChange(async (value) => {
								this.plugin.settings.saveTimer = value;
								await this.plugin.saveSettings();
								window.clearInterval(this.plugin.saveTimerIntervalId);
								this.plugin.saveTimerIntervalId = this.plugin.registerInterval(
									window.setInterval(() => this.plugin.writeDb(this.plugin.db), value)
								);
							})
					)

			);

		const exclusionsGroup = new SettingGroup(containerEl)
			.setHeading('Exclusions');
		exclusionsGroup.listEl.addClass('rcp-exclusion-list');
		exclusionsGroup.addSetting((setting) =>
				setting
					.setName('Exclude files and folders from tracking')
					.setDesc(
						'Files and folders matching these paths or glob patterns are never saved or restored. ' +
						'Patterns ending with "/" match a folder and everything inside it. ' +
						'Examples: "dashboard.md", "dashboards/", "**/templates/*.md".'
					)
			);

		let addText: TextComponent | null = null;
		exclusionsGroup.addSetting((setting) => {
			setting.settingEl.addClass('rcp-add-exclusion');
			return setting
				.setName('Add exclusion')
				.setDesc('Add a path or glob pattern for a file or folder to exclude.')
				.addText((text) => {
					addText = text;
					text.setPlaceholder('e.g. dashboards/ or **/templates/*.md');
					text.inputEl.addEventListener('keydown', (e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							this.addExclusion(addText);
						}
					});
				})
				.addButton((btn) =>
					btn
						.setButtonText('Add')
						.setCta()
						.onClick(() => {
							this.addExclusion(addText);
						})
				)
		});

		const excludedFiles = this.plugin.settings.excludedFiles || [];
		const tagsContainer = exclusionsGroup.listEl.createDiv({ cls: 'rcp-exclusion-tags' });
		if (excludedFiles.length === 0) {
			tagsContainer.createSpan({ cls: 'rcp-exclusion-empty', text: 'No excluded files or folders.' });
		} else {
			excludedFiles.forEach((pattern, index) => {
				const tag = tagsContainer.createSpan({ cls: 'rcp-exclusion-tag' });
				tag.createSpan({ cls: 'rcp-exclusion-tag-text', text: pattern });
				const removeBtn = tag.createEl('button', {
					cls: 'rcp-exclusion-tag-remove',
					text: '×',
					attr: { type: 'button', 'aria-label': 'Remove exclusion' },
				});
				removeBtn.addEventListener('click', () => {
					this.plugin.settings.excludedFiles.splice(index, 1);
					this.plugin.saveSettings().then(() => this.display());
				});
			});
		}

		const { pruneOrphans, maxAgeDays, maxCount } = this.plugin.settings;
		const pruningEnabled = pruneOrphans || maxAgeDays > 0 || maxCount > 0;
		const entryCount = Object.keys(this.plugin.db).length;

		new SettingGroup(containerEl)
			.setHeading('Data Management')
			.addSetting((setting) =>
				setting
					.setName('Remove entries for deleted or missing files')
					.setDesc(
						'On startup, remove saved positions for files that no longer exist in the vault. ' +
						'Disable this if you use junctions, removable drives, or other setups where files may be temporarily unavailable.'
					)
					.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.pruneOrphans)
							.onChange(async (value) => {
								this.plugin.settings.pruneOrphans = value;
								await this.plugin.saveSettings();
								this.display();
							})
					)
			)
			.addSetting((setting) =>
				setting
					.setName('Remove entries older than')
					.setDesc('On startup, remove saved positions for files that have not been visited within the selected period.')
					.addDropdown((drop) =>
						drop
							.addOption('30', '30 days')
							.addOption('60', '60 days')
							.addOption('90', '90 days')
							.addOption('365', '1 year')
							.addOption('0', 'Never')
							.setValue(String(this.plugin.settings.maxAgeDays))
							.onChange(async (value) => {
								this.plugin.settings.maxAgeDays = Number(value);
								await this.plugin.saveSettings();
								this.display();
							})
					)
			)
			.addSetting((setting) =>
				setting
					.setName('Maximum number of entries to keep')
					.setDesc('On startup, if the number of saved positions exceeds this limit, the oldest entries are removed. Most-recently visited files are kept. "None" means no maximum limit.')
					.addDropdown((drop) =>
						drop
							.addOption('50', '50')
							.addOption('100', '100')
							.addOption('250', '250')
							.addOption('500', '500')
							.addOption('0', 'None')
							.setValue(String(this.plugin.settings.maxCount))
							.onChange(async (value) => {
								this.plugin.settings.maxCount = Number(value);
								await this.plugin.saveSettings();
								this.display();
							})
					)
			)
			.addSetting((setting) =>
				setting
					.setName('Apply pruning rules')
					.setDesc(`Currently tracking ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}. Pruning runs automatically on next reload; use this to apply immediately.`)
					.addButton((btn) => {
						btn.setButtonText('Prune now')
							.setDisabled(!pruningEnabled);
						if (pruningEnabled) btn.setCta();
						btn.onClick(async () => {
							this.plugin.pruneDb();
							await this.plugin.writeDb(this.plugin.db);
							this.display();
						});
					})
			)
			.addSetting((setting) =>
				setting
					.setName('Forget all saved positions')
					.setDesc('Remove every saved cursor position from the database. This cannot be undone.')
					.addButton((btn) => {
						btn.setButtonText('Forget all')
							.setWarning();
						btn.onClick(async () => {
							const count = Object.keys(this.plugin.db).length;
							this.plugin.db = {};
							// Force writeDb to persist the empty database even though
							// both snapshots are now empty.
							this.plugin.lastSavedDb = { __forceWrite: true } as any;
							await this.plugin.writeDb(this.plugin.db);
							new Notice(`Remember cursor position: forgot ${count} saved ${count === 1 ? 'position' : 'positions'}.`);
							this.display();
						});
					})
			);

		if (scrollContainer) {
			scrollContainer.scrollTop = scrollTop;
		}
	}
}
