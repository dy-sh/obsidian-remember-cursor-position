import { App, MarkdownView, TAbstractFile, WorkspaceLeaf } from 'obsidian';
import { EphemeralState, PluginSettings } from './types';
import { CursorPositionDatabase } from './database';

// Owns all cursor-position recording, restoration, exclusion, and leaf-dedup
// logic, plus the shared state it requires. The plugin class stays a thin
// lifecycle/event orchestrator.
export class PositionManager {
	private app: App;
	private database: CursorPositionDatabase;
	settings: PluginSettings;

	lastEphemeralState: EphemeralState | undefined;
	lastLoadedFileName: string | undefined;
	loadingFile = false;
	handledLeafIds: Set<string> = new Set(); // 'leafId:filePath' identities already restored

	// Files whose saved position was injected into the open's ephemeral state
	// (setViewState patch) and therefore must not be restored a second time by
	// the file-open handler. Consumed when the matching file-open arrives; a
	// background open (active:false) produces no file-open, so its entry stays
	// until that tab is activated — which is exactly when it is needed.
	private injectedOpenPaths = new Set<string>();

	// Safety timers that lift the pre-first-paint cover of opens if the restore
	// never runs (background open, skipped restore, link navigation). The
	// restore's own reveal clears the cover earlier.
	private pendingCoverTimers: Map<WorkspaceLeaf, number> = new Map();

	private restoreRun = 0;     // bumped per restore; stale restores detect supersession
	private activeRestores = 0; // restore chains in flight (loadingFile derives from it)

	private recentLinkUse = false; // an openLinkText navigation is in flight
	private recentLinkTimeout = 0; // clears recentLinkUse shortly after it ends

	private excludedCache: Map<string, boolean> = new Map();
	private static readonly EXCLUDED_CACHE_SIZE = 32;

	// Fix wait after a restore before anchoring change detection. Covers
	// post-restore layout shifts (image decode, block resizing).
	private static readonly ANCHOR_SETTLE_DELAY = 100;

	// Bounded max for the pre-restore wait for the reading renderer to produce
	// the note (replaces the removed delayAfterFileOpening setting): covers
	// notes whose async render is unusually slow.
	private static readonly CONTENT_READY_MAX_MS = 500;

	// Bounded deadline for confirming a restore has settled under cover before
	// revealing.
	private static readonly RESTORE_PAINT_DEADLINE = 600;

	// Worst-case bound for the first-paint cover; only fires if a restore never
	// runs or completes. Larger than the sum of the two waits above so a slow
	// restore is never cut off mid-paint (which would flash the un-restored
	// top).
	private static readonly COVER_SAFETY_MS = 1200;

	constructor(app: App, database: CursorPositionDatabase, settings: PluginSettings) {
		this.app = app;
		this.database = database;
		this.settings = settings;
	}

	checkEphemeralStateChanged() {
		// The plugin only handles markdown views; other view types (canvas, PDF, etc.) are skipped entirely.
		let view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file)
			return;

		let fileName = view.file.path;

		// Skip while a restore is in flight, or when the active file is not the one we loaded
		// (lastLoadedFileName is unset until the first load, in which case it never matches)
		if (this.loadingFile || fileName != this.lastLoadedFileName)
			return;

		// Skip if file is excluded
		if (this.shouldSkipRecording(view)) {
			// drop stale record and do not record
			if (this.database.db[fileName]) {
				delete this.database.db[fileName];
				this.database.dbDirty = true;
			}
			this.lastEphemeralState = undefined;
			return;
		}

		let st = this.getEphemeralState(view);
		if (!st)
			return;

		if (!this.lastEphemeralState) {
			this.lastEphemeralState = st;
			return;
		}

		if (!this.isEphemeralStatesEquals(st, this.lastEphemeralState)) {
			this.database.setState(fileName, st);
			this.lastEphemeralState = st;
		}
	}

	private shouldSkipRecording(view: MarkdownView): boolean {
		// check if file is excluded
		if (view.file && this.isExcludedPath(view.file.path))
			return true;

		// check if file is shorter than the threshold
		if (this.settings.minLinesToRecord <= 0)
			return false;

		let editor = view.editor;
		return !!editor && editor.lineCount() < this.settings.minLinesToRecord;
	}

	// Called from the 100ms polling loop, so results are memoized per path.
	private isExcludedPath(path: string): boolean {
		const excludedFolders = this.settings.excludedFolders;
		if (excludedFolders.length === 0)
			return false;

		const cached = this.excludedCache.get(path);
		if (cached !== undefined)
			return cached;

		let result = false;
		for (const folder of excludedFolders) {
			if (path === folder || path.startsWith(folder + '/')) {
				result = true;
				break;
			}
		}

		if (this.excludedCache.size >= PositionManager.EXCLUDED_CACHE_SIZE)
			this.excludedCache.clear();
		this.excludedCache.set(path, result);
		return result;
	}

	private isEphemeralStatesEquals(state1: EphemeralState, state2: EphemeralState): boolean {
		const c1 = state1.cursor, c2 = state2.cursor;
		if (!!c1 !== !!c2) return false;
		if (c1 && (
			c1.from.ch !== c2!.from.ch || c1.from.line !== c2!.from.line ||
			c1.to.ch !== c2!.to.ch || c1.to.line !== c2!.to.line
		)) return false;

		return (state1.scroll ?? undefined) === (state2.scroll ?? undefined);
	}

	async restoreEphemeralState() {
		// The plugin only handles markdown views; other view types (canvas, PDF, etc.) are skipped entirely.
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file)
			return;

		const file = view.file;
		const fileName = file.path;

		// A source-mode open whose saved position was injected into core's
		// ephemeral-state argument (see injectEphemeralStateOnOpen). The restore
		// has already been applied by core; we only re-anchor bookkeeping and
		// skip applying it a second time. Consumed now so a later re-open of the
		// same file (this leaf re-used) restores again normally.
		const injected = this.injectedOpenPaths.delete(fileName);

		// Dedup: Obsidian fires 'file-open' repeatedly (pane switching, re-opening the same
		// file, workspace restore). Restore each leaf+file combination only once, otherwise
		// the cursor would keep jumping back to the saved position.
		//@ts-ignore no-official-API
		const identity = view.leaf.id + ':' + fileName;
		if (this.handledLeafIds.has(identity)) {
			// Already handled this session (e.g. this leaf+file restored before,
			// or a still-open pane with the same file): keep change detection
			// anchored to the active file so the polling loop keeps recording.
			// A reused reading leaf may have a cover applied for this open but
			// there is no restore to run — lift it now instead of waiting out
			// the safety timer.
			if (this.pendingCoverTimers.has(view.leaf))
				this.uncoverOpen(view.leaf);
			this.lastLoadedFileName = fileName;
			return;
		}

		// Snapshot all currently open markdown leaves as handled (also drops stale ids).
		this.handledLeafIds = this.getOpenMarkdownLeafIdentities();

		// Cancel any restore still in flight: rapid file switching reuses the
		// same MarkdownView instance, so a stale restore loop would keep
		// applying the previous file's position to the new note — random final
		// positions, flicker, and corrupted records via the polling loop.
		// Every await in the restore chain re-checks isCurrent() before
		// touching the view again.
		const run = ++this.restoreRun;
		const isCurrent = () => run === this.restoreRun && view.file?.path === fileName;

		this.activeRestores++;
		this.loadingFile = true;

		try {
			this.lastEphemeralState = undefined;
			this.lastLoadedFileName = fileName;

			const st = this.database.db[fileName];
			if (!st) {
				if (this.settings.defaultPosition === 'default'
					|| view.getMode() === 'preview')
					return;
			}

			if (injected && view.getMode() === 'source') {
				// Core already applied the saved position in setViewState.
				// Wait for it to be confirmed painted (a new editor measures
				// before its scroll lands), then lift the cover that hid the
				// first frames and re-anchor bookkeeping. Reading view never
				// injects, so this per-leaf cover check must not skip its masked
				// restore.
				if (this.pendingCoverTimers.has(view.leaf)) {
					try {
						await this.waitForInjectedRestorePainted(view, st, isCurrent);
					} finally {
						if (isCurrent())
							this.uncoverOpen(view.leaf);
					}
				}
				await this.anchorToSettledState(view, st, isCurrent);
				return;
			}

			// Everything not covered by the setViewState injection (reading
			// view, default positions, rare source-mode fallbacks) restores
			// through the masked path.
			await this.maskedRestore(view, st, isCurrent);
		} finally {
			this.activeRestores--;
			this.loadingFile = this.activeRestores > 0;
		}
	}

	// Injects the saved position into an open request's ephemeral-state
	// argument, so core applies it in the exact pipeline slot it uses for its
	// own position restore: synchronously with the content swap, before any
	// paint. This is the ONLY place a source-mode restore can be flicker-free
	// — 'file-open' is emitted through a debounced (setTimeout 0) callback,
	// i.e. after the note has already been painted at its default position.
	private injectEphemeralStateOnOpen(leaf: WorkspaceLeaf, viewState: any, eState: any): any {
		if (!viewState || viewState.type !== 'markdown')
			return eState;
		const filePath = viewState.state && viewState.state.file;
		if (!filePath)
			return eState;
		// Link navigation wins — core's target is authoritative.
		if (this.recentLinkUse)
			return eState;

		const isSourceMode = this.isSourceModeOpen(leaf, viewState);

		const merged: any = {};
		const st = this.database.db[filePath];
		if (st) {
			if (st.cursor)
				merged.cursor = st.cursor;
			if ((st?.scroll ?? 0) > 0)
				merged.scroll = st.scroll;
		} else {
			if (this.settings.defaultPosition === 'end' && isSourceMode) {
				// For both source (scroll+cursor to end synchronously) and the
				// no-record case. The placeholder cursor is clamped to the last
				// line by the editor; content length is unknown here.
				merged.scroll = Infinity;
				merged.cursor = {
					from: { line: Number.MAX_SAFE_INTEGER, ch: 0 },
					to:   { line: Number.MAX_SAFE_INTEGER, ch: 0 },
				};
			}
		}
		if (Object.keys(merged).length === 0)
			return eState;

		// The injection lands the merged state synchronously in setViewState.
		// For an existing source-mode markdown view, the scroll/cursor are
		// applied as part of that setViewState call and paint atomically, so no
		// cover is needed. But a brand-new view still has its old (non-Markdown)
		// leaf.view at this point: its editor is constructed later, measures its
		// document, and only then does the injected scroll land — so the first
		// frame can still paint the un-restored top. The same is true of a
		// reused markdown leaf opening in reading (preview) mode: its async
		// render paints the note at the top before the debounced file-open
		// handler can mask it, so cover those opens whenever a saved scroll is
		// coming. The injected branch of restoreEphemeralState waits for the
		// position to paint, then lifts the cover (the safety timer bounds it
		// for background opens).
		const newLeaf = !(leaf.view instanceof MarkdownView);
		const savedScroll = !!st && (st.scroll ?? 0) > 0;
		if (newLeaf || (!isSourceMode && savedScroll)) {
			this.coverOpen(leaf);

			// A mode toggle (existing source markdown view switching to reading)
			// does not fire 'file-open', so the restore that lifts this cover
			// never runs and the note stays blank until the safety timer.
			// Detect it here and run the restore ourselves: drop the leaf+file
			// identity so the restore isn't deduped into an early return (which
			// would lift the cover before the reading scroll lands), then
			// schedule it for right after the view has switched mode.
			const togglingToReading = !newLeaf
				&& leaf.view instanceof MarkdownView
				&& leaf.view.getMode() === 'source';
			if (togglingToReading) {
				//@ts-ignore no-official-API
				this.handledLeafIds.delete(leaf.view.leaf.id + ':' + filePath);
				window.setTimeout(() => this.restoreEphemeralState(), 0);
			}
		}

		// Let the file-open handler know the restore was applied here, so it
		// re-anchors bookkeeping without re-applying. Bookkeeping itself stays
		// in restoreEphemeralState (single owner of lastLoadedFileName,
		// handledLeafIds, loadingFile): pre-emptively writing those fields from
		// this patch blocked later file-opens and stopped change detection.
		this.injectedOpenPaths.add(filePath);

		return eState ? { ...eState, ...merged } : merged;
	}

	private isSourceModeOpen(leaf: WorkspaceLeaf, viewState: any): boolean {
		const mode = viewState.state && viewState.state.mode;
		if (mode === 'source')
			return true;
		if (mode === 'preview')
			return false;
		// No explicit mode: reuse the current view's mode when it is already a
		// markdown view; a brand-new view defaults to source (the common case).
		const view = leaf.view;
		if (view instanceof MarkdownView)
			return view.getMode() === 'source';
		return true;
	}

	// Hides an open before its first paint. 'file-open' fires through a
	// debounced (setTimeout 0) callback — after the view has already painted at
	// the top — so the restore cover alone can't hide that first frame. The
	// leaf's persistent .view-content is reused by the incoming view, so hiding
	// it here (synchronously with the open) covers the first paint; the restore
	// reveals at the restored position, and a bounded safety timer guarantees
	// the cover can never stick (background opens produce no file-open, and
	// restore skips/link navigation never call the restore).
	//
	// Both reading opens (async render) and injected source opens (a new editor
	// measures before its scroll lands) can paint the un-restored top, so both
	// call this from injectEphemeralStateOnOpen.
	private coverOpen(leaf: WorkspaceLeaf): void {
		this.coverLeaf(leaf);
		const existing = this.pendingCoverTimers.get(leaf);
		if (existing)
			window.clearTimeout(existing);
		this.pendingCoverTimers.set(leaf, window.setTimeout(() => {
			this.pendingCoverTimers.delete(leaf);
			this.uncoverOpen(leaf);
		}, PositionManager.COVER_SAFETY_MS));

		// A brand-new leaf creates its .view-content only inside the incoming
		// view's constructor, which runs after this patch returns. Keep
		// re-applying the cover on every frame (ahead of paint) so the freshly
		// built .view-content is hidden before its first frame can show the
		// un-restored top. Stops once the restore reveals (or the safety timer
		// lifted) the cover — both go through uncoverOpen.
		requestAnimationFrame(() => this.reapplyCover(leaf));
	}

	// Hides the open without exposing the theme's page background. Making
	// leaf.containerEl itself opacity:0 would render the whole leaf (and its
	// content card) transparent, revealing whatever the theme paints behind the
	// leaf — e.g. Soft Paper's sapphire --tab-container-background. Instead only
	// the inner .view-content (the actual content) is hidden, so the card's own
	// background stays visible; while that element does not exist yet (a
	// brand-new leaf), paint the leaf container with the theme's note background
	// so the area reads as a blank note rather than the page behind it.
	private coverLeaf(leaf: WorkspaceLeaf): void {
		// @ts-ignore no-official-API
		const vc = leaf.containerEl.querySelector('.view-content');
		if (vc instanceof HTMLElement) {
			vc.style.opacity = '0';
			// @ts-ignore no-official-API
			leaf.containerEl.style.backgroundColor = '';
		} else {
			// @ts-ignore no-official-API
			leaf.containerEl.style.backgroundColor = 'var(--background-primary)';
		}
	}

	// Re-applies the pre-paint cover on every frame while an open is still
	// covered. Catches the freshly built .view-content of a first open so no
	// frame of the un-restored top is ever shown. Stops as soon as the cover is
	// lifted (the restore reveal or the safety timer), both of which go through
	// uncoverOpen.
	private reapplyCover(leaf: WorkspaceLeaf): void {
		if (!this.pendingCoverTimers.has(leaf))
			return;
		this.coverLeaf(leaf);
		requestAnimationFrame(() => this.reapplyCover(leaf));
	}

	private uncoverOpen(leaf: WorkspaceLeaf): void {
		const pending = this.pendingCoverTimers.get(leaf);
		if (pending) {
			window.clearTimeout(pending);
			this.pendingCoverTimers.delete(leaf);
		}
		// @ts-ignore no-official-API
		const vc = leaf.containerEl.querySelector('.view-content');
		if (vc instanceof HTMLElement)
			vc.style.opacity = '';
		// @ts-ignore no-official-API
		leaf.containerEl.style.opacity = '';
		// @ts-ignore no-official-API
		leaf.containerEl.style.backgroundColor = '';
	}

	// Installs the patches the restore relies on:
	// 1. WorkspaceLeaf.prototype.setViewState — injects the saved position
	//    into the open's ephemeral state (see injectEphemeralStateOnOpen).
	//    This is the primary, flicker-free source-mode restore.
	// 2. workspace.openLinkText — flags heading/block link navigations so
	//    saved positions yield to link targets.
	// registerCleanup must schedule undoing all of them on plugin unload.
	installPatches(registerCleanup: (fn: () => void) => void) {
		const leafProto: any = WorkspaceLeaf.prototype;
		const originalSetViewState = leafProto.setViewState;
		if (typeof originalSetViewState === 'function') {
			const manager = this;
			leafProto.setViewState = function (this: WorkspaceLeaf, viewState: any, eState?: any) {
				eState = manager.injectEphemeralStateOnOpen(this, viewState, eState);
				return originalSetViewState.call(this, viewState, eState);
			};
			registerCleanup(() => {
				leafProto.setViewState = originalSetViewState;
			});
		}

		const workspace: any = this.app.workspace;
		const originalOpenLinkText = workspace.openLinkText;
		if (typeof originalOpenLinkText === 'function') {
			const manager = this;
			workspace.openLinkText = async function (this: any, ...args: any[]) {
				// Only links that target a sub-location (heading `#` / block `^`)
				// scroll to a target that must win over the saved position. Plain
				// file links should still restore the remembered position.
				const linktext: unknown = args[0];
				const hasTarget = typeof linktext === 'string'
					&& (linktext.includes('#') || linktext.includes('^'));
				if (!hasTarget)
					return originalOpenLinkText.apply(this, args);
				manager.recentLinkUse = true;
				try {
					return await originalOpenLinkText.apply(this, args);
				} finally {
					window.clearTimeout(manager.recentLinkTimeout);
					manager.recentLinkTimeout = window.setTimeout(() => {
						manager.recentLinkUse = false;
					}, 300);
				}
			};
			registerCleanup(() => {
				workspace.openLinkText = originalOpenLinkText;
			});
		}
	}

	// Restore for every case the setViewState injection
	// (injectEphemeralStateOnOpen) does not cover: reading view (async
	// render), default positions when there is no record, and the rare
	// source-mode opens that did not go through setViewState. The source-mode
	// fallback would otherwise flash the note at its default position before
	// scrolling to the saved one, so every path here restores under a hidden
	// cover. The note is hidden in the same task as 'file-open' — before the
	// first paint, when nothing is on screen yet — and revealed in the same
	// frame the restored position is confirmed painted, instantly and without
	// transition, so the uncover itself is not a visible effect. opacity keeps
	// the note's layout intact while hidden, so revealing is pure compositor
	// work (no reflow/repaint, unlike display:none-style hiding).
	private async maskedRestore(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		
		// Don't scroll when a link scrolls and highlights text
		// i.e. if file is open by links like [link](note.md#header) and wikilinks
		// See #10, #32, #46, #51 — core's target wins, we restore nothing.
		// Checked before the cover goes on so link navigation never blanks the
		// note; a flashing span that only appears later is caught again below.
		if (this.recentLinkUse || view.containerEl.querySelector('.is-flashing'))
			return;

		view.contentEl.style.opacity = '0';
		let restoredFromDb = false;
		try {
			// Wait only until the reading renderer has actually produced the
			// note (or a bounded max for views that never catch up), instead of
			// a fixed delay. The link-highlight span of a target scroll appears
			// with that render, so this also times the .is-flashing re-check to
			// when it can exist.
			await this.waitForContentReady(view, isCurrent);
			if (!isCurrent())
				return;

			let containsFlashingSpan = view.containerEl.querySelector('.is-flashing');

			if (!containsFlashingSpan) {
				await this.nextPaint();
				if (!isCurrent())
					return;
				if (st) {
					this.applyEphemeralState(view, st);
					restoredFromDb = true;
				} else {
					if (this.settings.defaultPosition === 'end') {
						this.setCursorToEnd(view);
					} else if (this.settings.defaultPosition === 'beforeFootnotes') {
						this.setCursorToBeforeFootnotes(view);
					}
				}
			}

			if (restoredFromDb && (st!.scroll ?? 0) > 0) {
				// Reading view scrolls only after async rendering; stay covered
				// until it reports the line (bounded so failures don't blank it).
				await this.waitForRestorePainted(view, st!, isCurrent);
			} else {
				// Sync restores; two frames ensure the result is painted.
				await this.nextPaint();
				await this.nextPaint();
			}
		} finally {
			if (isCurrent()) {
				// Lift the leaf-level cover applied by coverOpen (first open), then
				// always clear this restore's own cover on view.contentEl — the two
				// target different elements, so both must be cleared to reveal.
				if (this.pendingCoverTimers.has(view.leaf))
					this.uncoverOpen(view.leaf);
				view.contentEl.style.opacity = '';
			}
		}

		if (restoredFromDb && isCurrent())
			await this.anchorToSettledState(view, st, isCurrent);
	}

	// Shared post-restore bookkeeping: once a restore has landed (either core
	// applied it via setViewState injection, or maskedRestore did), anchor
	// change detection to where the view actually settled, not the value we
	// requested. Integer quantization already absorbs applyScroll's
	// small landing error inside its ±0.5 dead zone, but images that finish
	// loading *above* the viewport can shift the readback by whole lines —
	// past the dead zone. If we anchored to the requested value, the polling
	// loop would treat that layout-shift-induced jump as a user scroll and
	// overwrite the saved position. Anchoring to the settled state (after the
	// fixed ANCHOR_SETTLE_DELAY so post-restore layout shifts settle first)
	// keeps the db at the position the user actually saved; genuine scrolls
	// after this point still update it normally.
	private async anchorToSettledState(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		await this.delay(PositionManager.ANCHOR_SETTLE_DELAY);
		// A superseded restore must never anchor: lastEphemeralState would
		// describe the wrong file and the polling loop would write it to the db.
		if (isCurrent())
			this.lastEphemeralState = this.getEphemeralState(view) ?? st;
	}

	// Whether the state requested in setEphemeralState() is what the view now
	// reports. Scroll is compared exactly: applyScroll lands within ~0.04 line
	// of the request and Math.round's ±0.5 dead zone absorbs that. A missing
	// readback cursor means a collapsed (0,0) cursor — the editor's default —
	// so it matches a saved (0,0) cursor.
	private isRestoreStuck(view: MarkdownView, st: EphemeralState): boolean {
		const now = this.getEphemeralState(view);
		if (!now)
			return false;
		if ((st.scroll ?? 0) > 0 && now.scroll !== st.scroll)
			return false;
		const want = st.cursor;
		if (!want)
			return true;
		const got = now.cursor ?? { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
		return want.from.line === got.from.line && want.from.ch === got.from.ch
			&& want.to.line === got.to.line && want.to.ch === got.to.ch;
	}

	// Resolves once an injected open's position is confirmed painted, then the
	// caller lifts the cover. Core applied the state in setViewState, so we
	// only observe — never re-apply, which would fight core's own open
	// pipeline. A new source editor measures its document before its scroll can
	// land, so wait until the readback reports the position (short bound
	// covers the measure frame; a failure to land just reveals at the default
	// position instead of blanking the note). An 'end' default-position open
	// (no record) has nothing to wait on beyond a paint: scroll-to-end is one
	// synchronous editor op, and a note too short to scroll is already fully
	// visible.
	private async waitForInjectedRestorePainted(view: MarkdownView, st: EphemeralState | undefined, isCurrent: () => boolean) {
		if (!st) {
			await this.nextPaint();
			await this.nextPaint();
			return;
		}
		const deadline = Date.now() + 200;
		let stableFrames = 0;
		while (Date.now() < deadline && isCurrent()) {
			await this.nextPaint();
			if (!isCurrent())
				return;
			if (this.isRestoreStuck(view, st)) {
				if (++stableFrames >= 2)
					return;
			} else {
				stableFrames = 0;
			}
		}
	}

	// Resolves once the reading renderer has produced the note's content, or
	// after a bounded wait for views that never catch up. Reading view renders
	// asynchronously: the saved scroll can only be applied — and the
	// link-highlight span can only appear — once that render lands. Polling
	// render state instead of sleeping a fixed delay keeps the covered blank
	// time equal to the real render time, with no arbitrary minimum on top.
	private async waitForContentReady(view: MarkdownView, isCurrent: () => boolean): Promise<void> {
		const deadline = Date.now() + PositionManager.CONTENT_READY_MAX_MS;
		while (isCurrent() && Date.now() < deadline) {
			if (this.isContentReady(view))
				return;
			await this.nextPaint();
		}
	}

	private isContentReady(view: MarkdownView): boolean {
		// Source mode needs no async render; the editor is synchronous.
		if (view.getMode() === 'source')
			return true;
		// The preview sizer holds the rendered blocks; before the async render
		// completes it is empty or not yet laid out.
		const sizer = view.containerEl.querySelector<HTMLElement>('.markdown-preview-sizer');
		return !!sizer && sizer.children.length > 0 && sizer.scrollHeight > 0;
	}

	// Resolves once the restored position has STAYED put for three consecutive
	// frames (or after a bounded wait for views whose async rendering never
	// catches up). Reading view applies a scroll only once its renderer has
	// produced the target lines, and Obsidian's staged open pipeline can reset
	// the scroll after it first lands — so keep re-applying on drift while
	// covered, and only uncover once nothing is fighting us anymore.
	private async waitForRestorePainted(view: MarkdownView, st: EphemeralState, isCurrent: () => boolean) {
		const deadline = Date.now() + PositionManager.RESTORE_PAINT_DEADLINE;
		let stableFrames = 0;
		while (Date.now() < deadline && isCurrent()) {
			await this.nextPaint();
			if (!isCurrent())
				return;
			if (this.isRestoreStuck(view, st)) {
				if (++stableFrames >= 3)
					return;
			} else {
				stableFrames = 0;
				this.applyEphemeralState(view, st);
			}
		}
	}

	// Resolves on the next animation frame — the earliest moment a pending
	// paint has certainly been composited. rAF stalls while the window is
	// hidden, so race it with a timeout to avoid hanging restores.
	private nextPaint(): Promise<void> {
		return new Promise(resolve => {
			requestAnimationFrame(() => resolve());
			setTimeout(resolve, 100);
		});
	}

	private getOpenMarkdownLeafIdentities(): Set<string> {
		const identities = new Set<string>();
		this.app.workspace.iterateAllLeaves((leaf: any) => {
			if (!(leaf.view instanceof MarkdownView) || !leaf.view.file)
				return;
			//@ts-ignore no-official-API
			identities.add(leaf.view.leaf.id + ':' + leaf.view.file.path);
		});
		return identities;
	}

	renameFile(file: TAbstractFile, oldPath: string) {
		this.database.renameFile(file, oldPath);
		if (this.lastLoadedFileName == oldPath)
			this.lastLoadedFileName = file.path;
	}

	deleteFile(file: TAbstractFile) {
		this.database.deleteFile(file);
	}

	// Clears the exclusion-path memoization. Called when settings change, since
	// the excluded-folders list may have changed.
	clearExclusionCache() {
		this.excludedCache.clear();
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	private getEphemeralState(view: MarkdownView): EphemeralState | undefined {
		const scroll = view.currentMode?.getScroll();
		if (scroll === undefined || isNaN(scroll))
			return undefined;

		// getScroll() returns a 0-based top visible line number plus a fraction of
		// how far that line is scrolled through (e.g. 42.37 = viewport top sits 37%
		// into line 43). We deliberately quantize to whole lines:
		//
		// 1. Reading continuity. Restoring to a line *top* is the position that
		//    lets reading resume: the saved fraction points into the middle of a
		//    line the user had already partially read, and re-creating that
		//    half-read state forces the eye to re-scan a broken line before
		//    thought continues. Quantizing costs at most half a line of re-read
		//    and never loses content. For tall blocks (images, embeds) a
		//    fractional restore yields "half an image on screen" — not a useful
		//    reading position; landing on the block top (or past it) is.
		// 2. Round-trip stability. applyScroll(n) lands exactly on a line top;
		//    the residual landing error (pixel rounding) is ~0.04 line, well
		//    inside Math.round's ±0.5 dead zone. So: save 42 -> land 42.0x ->
		//    read back 42 -> no db write, ever. Finer quantization (e.g. 2
		//    decimals) shrinks the dead zone below the landing error, and the
		//    exact-=== change check then writes the drifted readback to the db,
		//    ratcheting the saved scroll by one step on every open.
		// 3. Must be Math.round, not Math.floor. floor's dead zone is
		//    asymmetric: [n-1, n) instead of [n-0.5, n+0.5). It tolerates ~1 line
		//    of upward deviation but *zero* downward deviation, so any landing or
		//    layout shift slightly below the saved value re-introduces one-way
		//    downward drift. Only a symmetric dead zone absorbs noise in both
		//    directions. (Obsidian's own outline sync also uses Math.round here.)
		let state: EphemeralState = { scroll: Math.round(scroll) };

		let editor = view.editor;
		if (editor) {
			let from = editor.getCursor("anchor");
			let to = editor.getCursor("head");
			// A collapsed cursor at (0,0) is where the editor opens anyway — omit it
			// so such records stay minimal ([0] tombstones / scroll-only records).
			if (from && to && (from.line !== 0 || from.ch !== 0 || to.line !== 0 || to.ch !== 0)) {
				state.cursor = {
					from: { ch: from.ch, line: from.line },
					to: { ch: to.ch, line: to.line }
				}
			}
		}

		return state;
	}

	private applyEphemeralState(view: MarkdownView, state: EphemeralState) {
		const eState: Record<string, unknown> = {};
		if (state.cursor)
			eState.cursor = state.cursor;
		if (state.scroll != null && state.scroll > 0)
			eState.scroll = state.scroll;
		if (eState.cursor || eState.scroll != null)
			view.setEphemeralState(eState);
	}

	private setCursorToEnd(view: MarkdownView) {
		let editor = view.editor;
		if (editor) {
			let lastLine = editor.lastLine();
			let lastLineLength = editor.getLine(lastLine).length;
			editor.setCursor({ line: lastLine, ch: lastLineLength });
			editor.scrollIntoView({ from: { line: lastLine, ch: 0 }, to: { line: lastLine, ch: lastLineLength } }, true);
		}
	}

	private setCursorToBeforeFootnotes(view: MarkdownView) {
		const editor = view.editor;
		if (!editor) {
			return;
		}
		// Use the already-loaded view data instead of a disk read: the view is
		// open, so `view.data` holds the current note content and keeps this
		// synchronous.
		const lines = view.data ? view.data.split('\n') : [];
		const footnoteLine = lines.findIndex((line) => /^\s*\[\^[^\]]+\]:\s/.test(line));
		if (footnoteLine === -1) {
			this.setCursorToEnd(view);
			return;
		}
		// Walk up from just above the footnote block, skipping blank/separator
		// lines, so the cursor lands on the last real content line.
		let targetLine = footnoteLine - 1;
		while (targetLine >= 0 && lines[targetLine].trim() === '') {
			targetLine--;
		}
		targetLine = Math.min(Math.max(0, targetLine), editor.lineCount() - 1);
		const ch = editor.getLine(targetLine).length;
		editor.setCursor({ line: targetLine, ch });
		editor.scrollIntoView({ from: { line: targetLine, ch: 0 }, to: { line: targetLine, ch } }, true);
	}
}
