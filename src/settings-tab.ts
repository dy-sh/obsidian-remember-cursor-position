import { App, PluginSettingTab, SettingDefinitionItem, FuzzySuggestModal, TFolder } from 'obsidian';
import type RememberCursorPosition from '../main';
import { SAFE_DB_FLUSH_INTERVAL } from './types';

export class SettingTab extends PluginSettingTab {
	plugin: RememberCursorPosition;

	constructor(app: App, plugin: RememberCursorPosition) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Default cursor position',
				desc: "When no saved position exists for a file, jump to this position. Note: 'End' and 'Before footnotes' only apply in source mode; in reading view the default position is used instead.",
				control: {
					type: 'dropdown',
					key: 'defaultPosition',
					options: {
						default: "Default (Obsidian's default)",
						end: 'End',
						beforeFootnotes: 'Before footnotes',
					},
				},
			},
			{
				name: 'Data file path',
				desc: 'Full path to the JSON file. Leave empty to use the default path. Only files inside the vault are supported.',
				control: {
					type: 'text',
					key: 'dbFileName',
					placeholder: this.plugin.database.defaultDbFileName,
				},
			},
			{
				name: 'Delay between saving the cursor position to file',
				desc: "Useful for multi-device users. If you don't want to wait until closing Obsidian to the cursor position been saved.",
				render: (setting) => {
					setting.addSlider((text) =>
						text
							.setLimits(SAFE_DB_FLUSH_INTERVAL, SAFE_DB_FLUSH_INTERVAL * 10, 10)
							.setValue(this.plugin.settings.saveTimer)
							.onChange(async (value) => {
								this.plugin.settings.saveTimer = value;
								await this.plugin.saveSettings();
								window.clearInterval(this.plugin.saveTimerIntervalId);
								this.plugin.saveTimerIntervalId = this.plugin.registerInterval(
									window.setInterval(() => this.plugin.database.writeDb(), value)
								);
							})
					);
				},
			},
			{
				type: 'group',
				heading: 'Do not record',
				items: [
					{
						name: 'Do not record files shorter than',
						desc: 'Do not remember cursor/scroll position for files with fewer lines than this value. "0" disables this filter.',
						control: {
							type: 'slider',
							key: 'minLinesToRecord',
							min: 0,
							max: 500,
							step: 5,
						},
					},
					{
						type: 'page',
						name: 'Excluded folders',
						desc: 'Do not remember the cursor and scroll position for files in these folders and their subfolders. Saved positions for files in excluded folders are removed automatically on startup.',
						displayValue: () => {
							const folders = this.plugin.settings.excludedFolders;
							if (folders.length === 0)
								return 'None';
							if (folders.length <= 3)
								return folders.join(', ');
							return folders.slice(0, 3).join(', ') + ` (+${folders.length - 3} more)`;
						},
						items: [
							{
								type: 'list',
								emptyState: 'No folders excluded',
								items: this.plugin.settings.excludedFolders.map((folder) => ({
									name: folder + '/',
								})),
								onDelete: async (index) => {
									this.plugin.settings.excludedFolders.splice(index, 1);
									await this.plugin.saveSettings();
									this.update();
								},
								addItem: {
									name: 'Add folder',
									action: () => {
										new FolderSuggestModal(
											this.app,
											this.plugin.settings.excludedFolders,
											(path) => {
												this.plugin.settings.excludedFolders.push(path);
												this.plugin.saveSettings().then(() => this.update());
											}
										).open();
									},
								},
							},
						],
					},
				],
			},
			{
				type: 'group',
				heading: 'Pruning',
				items: [
					{
						name: 'Stored positions',
						render: (setting) => {
							const count = Object.keys(this.plugin.database.db).length;
							setting.setDesc(
								`Currently tracking ${count} ${count === 1 ? 'entry' : 'entries'}. The database is kept small automatically; if it grows too large, the least-recently-visited files are removed first.`
							);
						},
					},
				],
			},
		];
	}
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private excludedFolders: string[],
		private onSelect: (path: string) => void
	) {
		super(app);
		this.setPlaceholder('Type to search folders...');
		this.limit = 50;
		this.emptyStateText = 'No folders found';
	}

	getItems(): TFolder[] {
		return this.app.vault.getAllFolders(false)
			.filter((f) => {
				return !this.excludedFolders.some(folder =>
					f.path === folder || f.path.startsWith(folder + '/')
				);
			})
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onSelect(folder.path);
	}
}
