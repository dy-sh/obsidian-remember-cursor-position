import { App, Plugin, PluginSettingTab, Setting, MarkdownView, View, MarkdownSubView } from 'obsidian';
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
	}

	scroll?: number
}


export default class RememberCursorPosition extends Plugin {
	settings: PluginSettings;
	lastEphemeralState: EphemeralState;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => this.restoreEphemeralState()),
		);

		this.registerInterval(window.setInterval(() => this.checkPagePosition(), 500));
	}

	checkPagePosition() {
		let st = this.getEphemeralState();

		if (!this.lastEphemeralState)
			this.lastEphemeralState = st;

		if (!this.isEphemeralStatesEquals(st, this.lastEphemeralState)) {
			this.lastEphemeralState = st;
			this.saveEphemeralState(st)
		}
	}

	isEphemeralStatesEquals(state1: EphemeralState, state2: EphemeralState): boolean {
		return JSON.stringify(state1) === JSON.stringify(state2)
	}

	async saveEphemeralState(state: EphemeralState) {
		let fileName = this.app.workspace.getActiveFile().path.trim(); //this.app.workspace.activeLeaf.view.file.path.trim()

		let db = await this.readDb();
		db[fileName] = state;
		this.writeDb(db);
	}

	async restoreEphemeralState() {
		this.lastEphemeralState = {}

		let db = await this.readDb();
		let fileName = this.app.workspace.getActiveFile().path.trim();
		let st = db[fileName];

		if (st) {
			this.setEphemeralState(st);
			this.lastEphemeralState = st;
		}
	}

	async readDb(): Promise<{ [file_path: string]: EphemeralState; }> {
		let positions_dict: { [file_path: string]: EphemeralState; } = {}

		if (await this.app.vault.adapter.exists(this.settings.dbFileName)) {
			let data = await this.app.vault.adapter.read(this.settings.dbFileName);
			positions_dict = JSON.parse(data);
		}

		return positions_dict;
	}

	async writeDb(db: { [file_path: string]: EphemeralState; }) {
		await this.app.vault.adapter.write(this.settings.dbFileName, JSON.stringify(db));
	}




	getEphemeralState(): EphemeralState {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view.getEphemeralState();
	}

	setEphemeralState(state: EphemeralState) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		view.setEphemeralState(state)
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
