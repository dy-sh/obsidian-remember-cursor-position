import { App, Plugin, PluginSettingTab, Setting, MarkdownView, TAbstractFile } from 'obsidian';
import * as CodeMirror from "codemirror";

interface PluginSettings {
	dbFileName: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	dbFileName: '.obsidian\\plugins\\obsidian-remember-cursor-position\\cursor-positions.json'
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

	async onload() {
		await this.loadSettings();

		this.db = await this.readDb();

		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => this.restoreEphemeralState()),
		);


		this.registerEvent(
			this.app.workspace.on('quit', () => { this.writeDb(this.db) }),
		);


		this.registerEvent(
			this.app.vault.on('closed', () => console.log("closed")),
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => this.renameFile(file, oldPath)),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => this.deleteFile(file)),
		);

		this.registerInterval(window.setInterval(() => this.checkEphemeralStateChanged(), 100));

		this.restoreEphemeralState();
	}




	renameFile(file: TAbstractFile, oldPath: string) {
		console.log("rename");
		let newName = file.path.trim();
		let oldName = oldPath.trim();
		this.db[newName] = this.db[oldName]
		delete this.db[oldName];
	}

	deleteFile(file: TAbstractFile) {
		console.log("delete")
		let fileName = file.path.trim();
		delete this.db[fileName];
	}

	checkEphemeralStateChanged() {
		let st = this.getEphemeralState();
		let fileName = this.app.workspace.getActiveFile()?.path?.trim();

		if (fileName != this.lastLoadedFileName) //waiting for load new file
			return;

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

		if (state1.scroll != state2.scroll)
			return false;

		return true;
	}

	async saveEphemeralState(st: EphemeralState) {
		let fileName = this.app.workspace.getActiveFile()?.path?.trim();
		if (fileName && fileName == this.lastLoadedFileName) { //do not save if file changed and was not loaded
			console.log("save " + fileName);
			console.log(this.lastEphemeralState)			
			console.log(st)
			this.db[fileName] = st;
			// this.writeDb(this.db)
		}
	}

	async delay(ms: number) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	async restoreEphemeralState() {

		await this.delay(100)

		let fileName = this.app.workspace.getActiveFile()?.path?.trim();
		if (this.lastLoadedFileName != fileName) {
			console.log("open " + fileName)
			this.lastEphemeralState = {}
			this.lastLoadedFileName = fileName;

			if (fileName) {
				console.log("restore " + fileName);
				let st = this.db[fileName];
				if (st) {
					this.setEphemeralState(st);
					this.lastEphemeralState = st;
				}
			}
		}

	}

	async readDb(): Promise<{ [file_path: string]: EphemeralState; }> {
		console.log("readDb");
		let db: { [file_path: string]: EphemeralState; } = {}

		if (await this.app.vault.adapter.exists(this.settings.dbFileName)) {
			let data = await this.app.vault.adapter.read(this.settings.dbFileName);
			db = JSON.parse(data);
		}

		return db;
	}

	async writeDb(db: { [file_path: string]: EphemeralState; }) {
		console.log("writeDb");
		await this.app.vault.adapter.write(this.settings.dbFileName, JSON.stringify(db));
	}




	getEphemeralState(): EphemeralState {
		// let state: EphemeralState = this.app.workspace.getActiveViewOfType(MarkdownView)?.getEphemeralState(); //Does not work properly

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
		if (view && state.scroll) {
			view.setEphemeralState(state);
			view.previewMode.applyScroll(state.scroll);
			view.sourceMode.applyScroll(state.scroll);
		}

		if (state.cursor) {
			let editor = this.getEditor();
			editor.setSelection(state.cursor.from, state.cursor.to);
		}
	}

	private getEditor(): CodeMirror.Editor {
		return this.app.workspace.activeLeaf?.view?.sourceMode?.cmEditor;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}



class SampleSettingTab extends PluginSettingTab {
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
