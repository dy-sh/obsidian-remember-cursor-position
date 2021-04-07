import { App, Plugin, PluginSettingTab, Setting, MarkdownView, TAbstractFile } from 'obsidian';
import * as CodeMirror from "codemirror";

interface PluginSettings {
	dbFileName: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	dbFileName: '.obsidian/plugins/remember-cursor-position/cursor-positions.json'
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
	scroll?: number
}


export default class RememberCursorPosition extends Plugin {
	settings: PluginSettings;
	db: { [file_path: string]: EphemeralState; };
	lastEphemeralState: EphemeralState;
	lastLoadedFileName: string;
	loadingFile = false;

	async onload() {
		await this.loadSettings();

		try {
			this.db = await this.readDb();
		}
		catch (e) {
			console.error("Remember Cursor Position plugin cant read db: " + e);
			this.db = {}
		}

		this.addSettingTab(new SettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => this.restoreEphemeralState()),
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
		this.registerInterval(window.setInterval(() => this.checkEphemeralStateChanged(), 100));

		this.restoreEphemeralState();
	}


	renameFile(file: TAbstractFile, oldPath: string) {
		let newName = file.path;
		let oldName = oldPath;
		this.db[newName] = this.db[oldName]
		delete this.db[oldName];
	}


	deleteFile(file: TAbstractFile) {
		let fileName = file.path;
		delete this.db[fileName];
	}


	checkEphemeralStateChanged() {
		let fileName = this.app.workspace.getActiveFile()?.path;

		//waiting for load new file
		if (!fileName || !this.lastLoadedFileName || fileName != this.lastLoadedFileName || this.loadingFile)
			return;

		let st = this.getEphemeralState();

		if (!this.lastEphemeralState)
			this.lastEphemeralState = st;

		if (!this.isEphemeralStatesEquals(st, this.lastEphemeralState)) {
			this.saveEphemeralState(st)
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

		if (state1.scroll) {
			if (state1.scroll != state2.scroll)
				return false;
		}

		return true;
	}


	async saveEphemeralState(st: EphemeralState) {
		let fileName = this.app.workspace.getActiveFile()?.path;
		if (fileName && fileName == this.lastLoadedFileName) { //do not save if file changed and was not loaded
			this.db[fileName] = st;
		}
	}


	async restoreEphemeralState() {
		let fileName = this.app.workspace.getActiveFile()?.path;

		if (fileName && this.loadingFile && this.lastLoadedFileName == fileName) //if already started loading
			return;

		this.loadingFile = true;

		if (this.lastLoadedFileName != fileName) {
			this.lastEphemeralState = {}
			this.lastLoadedFileName = fileName;

			if (fileName) {
				let st = this.db[fileName];
				if (st) {
					//waiting for load note		
					await this.delay(1)
					let scroll: number;
					for (let i = 0; i < 20; i++) {
						scroll = this.app.workspace.getActiveViewOfType(MarkdownView)?.currentMode?.getScroll();
						if (scroll !== null)
							break;
						await this.delay(10)
					}

					//if note opened by link like [link](note.md#header), do not scroll it
					if (scroll === 0) {
						//force update scroll while note is loading
						//todo: find better solution to wait for file loaded
						for (let i = 0; i < 20; i++) {	
							this.setEphemeralState(st);
							await this.delay(10)
						}
					}
				}
				this.lastEphemeralState = st;
			}

			this.loadingFile = false;
		}

	}

	async readDb(): Promise<{ [file_path: string]: EphemeralState; }> {
		let db: { [file_path: string]: EphemeralState; } = {}

		if (await this.app.vault.adapter.exists(this.settings.dbFileName)) {
			let data = await this.app.vault.adapter.read(this.settings.dbFileName);
			db = JSON.parse(data);
		}

		return db;
	}

	async writeDb(db: { [file_path: string]: EphemeralState; }) {
		await this.app.vault.adapter.write(this.settings.dbFileName, JSON.stringify(db));
	}



	getEphemeralState(): EphemeralState {
		// let state: EphemeralState = this.app.workspace.getActiveViewOfType(MarkdownView)?.getEphemeralState(); //doesnt work properly

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
				editor.setSelection(state.cursor.from, state.cursor.to, { scroll: false });
			}
		}

		if (view && state.scroll) {
			view.setEphemeralState(state);
			// view.previewMode.applyScroll(state.scroll);
			// view.sourceMode.applyScroll(state.scroll);
		}
	}

	private getEditor(): CodeMirror.Editor {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.sourceMode.cmEditor;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async delay(ms: number) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}



class SettingTab extends PluginSettingTab {
	plugin: RememberCursorPosition;

	constructor(app: App, plugin: RememberCursorPosition) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		let { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Remember cursor position - Settings' });

		new Setting(containerEl)
			.setName('Data file name')
			.setDesc('Save positions to this file')
			.addText(text => text
				.setPlaceholder('Example: cursor-positions.json')
				.setValue(this.plugin.settings.dbFileName)
				.onChange(async (value) => {
					this.plugin.settings.dbFileName = value;
					await this.plugin.saveSettings();
				}));
	}
}
