
interface CursorPos {
	ch: number;
	line: number;
}

interface EphemeralState {
	scroll?: number,
	cursor?: {
		from: CursorPos,
		to: CursorPos
	},
}

interface PluginSettings {
	dbFileName: string;
	saveTimer: number;
	minLinesToRecord: number; // 0 = disabled, do not record positions for files with fewer lines
	excludedFolders: string[]; // do not record positions for files in these folders and their subfolders
	defaultPosition: 'default' | 'end' | 'beforeFootnotes';
}

export const SAFE_DB_FLUSH_INTERVAL = 5000;

export const DEFAULT_SETTINGS: PluginSettings = {
	dbFileName: '',
	saveTimer: SAFE_DB_FLUSH_INTERVAL,
	minLinesToRecord: 15,
	excludedFolders: [],
	defaultPosition: 'default',
};

export {
	CursorPos,
	EphemeralState,
	PluginSettings,
};
