import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import * as CodeMirror from "codemirror";

interface PluginSettings {
	dbFileName: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	dbFileName: '.obsidian\\plugins\\obsidian-remember-cursor-position\\cursor-positions.json'
}

interface CursorPosition {
	line: number;
	ch: number;
}

export default class CodeBlockFromSelection extends Plugin {
	settings: PluginSettings;
	currentPos: CursorPosition;

	async onload() {
		await this.loadSettings();

		// this.addCommand({
		// 	id: 'test-action1',
		// 	name: 'Test',
		// 	callback: () => this.saveScrollPosition(),
		// 	hotkeys: [{ modifiers: ["Alt"], key: "1", },],
		// });

		// this.addCommand({
		// 	id: 'test-action2',
		// 	name: 'Test',
		// 	callback: () => this.restoreScrollPosition(),
		// 	hotkeys: [{ modifiers: ["Alt"], key: "2", },],
		// });

		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => this.restoreScrollPosition()),
		);

		this.registerInterval(window.setInterval(() => this.checkPagePosition(), 500));
	}

	checkPagePosition() {
		let pos = this.getCursorPosition();

		if (!this.currentPos)
			this.currentPos = pos;

		if (this.currentPos.ch != pos.ch || this.currentPos.line != pos.line) {
			this.currentPos = pos;
			this.saveScrollPosition()
		}
	}

	async saveScrollPosition() {
		let editor = this.getEditor();

		console.log(editor.getScrollInfo())

		let pos = this.getCursorPosition();
		let fileName = this.app.workspace.getActiveFile().path.trim(); //this.app.workspace.activeLeaf.view.file.path.trim()

		let db = await this.readDb();
		db[fileName] = pos;
		this.writeDb(db);
	}

	async restoreScrollPosition() {
		let db = await this.readDb();

		let fileName = this.app.workspace.getActiveFile().path.trim();
		let pos = db[fileName];
		console.log(pos)

		if (pos) {
			this.scrollTo(pos.line)
			this.setCursorPosition(pos);
		}
	}

	async readDb(): Promise<{ [file_path: string]: CursorPosition; }> {
		let positions_dict: { [file_path: string]: CursorPosition; } = {}

		if (await this.app.vault.adapter.exists(this.settings.dbFileName)) {
			let data = await this.app.vault.adapter.read(this.settings.dbFileName);
			positions_dict = JSON.parse(data);
		}

		return positions_dict;
	}

	async writeDb(db: { [file_path: string]: CursorPosition; }) {
		await this.app.vault.adapter.write(this.settings.dbFileName, JSON.stringify(db));
	}


	getCursorPosition(): CursorPosition {
		let editor = this.getEditor();
		let cursor = editor.getCursor();

		return {
			line: cursor.line,
			ch: cursor.ch
		};
	}

	setCursorPosition(pos: CursorPosition) {
		let editor = this.getEditor();
		editor.setCursor(pos.line, pos.ch);
	}

	scrollTo(line: number) {
		let editor = this.getEditor();

		var t = editor.charCoords({ line: line, ch: 0 }, "local").top;
		var middleHeight = editor.getScrollerElement().offsetHeight / 2;
		editor.scrollTo(null, t - middleHeight - 5);
	}

	private getEditor(): CodeMirror.Editor {
		let activeLeaf: any = this.app.workspace.activeLeaf;
		return activeLeaf.view.sourceMode.cmEditor;
	}



	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}



class SampleSettingTab extends PluginSettingTab {
	plugin: CodeBlockFromSelection;

	constructor(app: App, plugin: CodeBlockFromSelection) {
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
