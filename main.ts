import { Plugin } from 'obsidian';
import { SettingTab } from './src/settings-tab';
import { PluginSettings, SAFE_DB_FLUSH_INTERVAL, DEFAULT_SETTINGS } from './src/types';
import { CursorPositionDatabase } from './src/database';
import { PositionManager } from './src/position-manager';


export default class RememberCursorPosition extends Plugin {
	settings!: PluginSettings;
	database!: CursorPositionDatabase;
	manager!: PositionManager;
	saveTimerIntervalId!: number;

	async onload() {
		await this.loadSettings();

		await this.database.readDb();
		this.database.pruneDb();

		this.addSettingTab(new SettingTab(this.app, this));

		// Restore patches: view.setEphemeralState argument rewriting (the
		// primary, flicker-free restore path — core applies our saved position
		// in its own pipeline slot) and openLinkText link detection (saved
		// positions yield to link targets). Both are undone on unload.
		this.manager.installPatches(cleanup => this.register(cleanup));

		this.registerEvent(this.app.workspace.on('file-open', () => this.manager.restoreEphemeralState()));
		this.registerEvent(this.app.workspace.on('quit', () => { this.database.writeDb() }));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.manager.renameFile(file, oldPath)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.manager.deleteFile(file)));

		//todo: replace by scroll and mouse cursor move events
		this.registerInterval(
			window.setInterval(() => this.manager.checkEphemeralStateChanged(), 100)
		);

		this.saveTimerIntervalId = this.registerInterval(
			window.setInterval(() => this.database.writeDb(), this.settings.saveTimer)
		);

		this.manager.restoreEphemeralState();
	}

	//----------------------------------------------------------------------------------------

	async loadSettings() {
		const settings: PluginSettings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		if (settings.saveTimer < SAFE_DB_FLUSH_INTERVAL)
			settings.saveTimer = SAFE_DB_FLUSH_INTERVAL;

		this.settings = settings;
		this.database = new CursorPositionDatabase(
			this.app,
			this.manifest!.dir!,
			this.settings
		);
		this.manager = new PositionManager(this.app, this.database, this.settings);

		if (!(await this.database.ensureDbFolder())) {
			await this.saveData(this.settings);
		}
	}

	async saveSettings() {
		this.manager.clearExclusionCache();
		await this.database.ensureDbFolder();
		await this.saveData(this.settings);
	}
}
