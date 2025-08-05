import { injectable, inject } from '@theia/core/shared/inversify';
import {
    FrontendApplicationContribution, QuickPickService
} from '@theia/core/lib/browser';
import {
    Command, CommandContribution, MenuContribution,
    CommandRegistry, MenuModelRegistry
} from '@theia/core/lib/common';
import { EditorManager, EditorWidget } from '@theia/editor/lib/browser';
import * as monaco from '@theia/monaco-editor-core/esm/vs/editor/editor.api';

/* ───────── Types and Constants ───────── */
type Kind = 'red underline' | 'orange underline' | 'yellow underline' | 'gray underline' | 'red highlight' |'orange highlight' | 'yellow highlight' | 'gray highlight';

// Interface for comments as they are stored in the external JSON file
interface ExternalComment {
    id: string;
    file: string;
    type: Kind;
    title: string;
    content: string;
    suggestion: string;
    anchor: AnchorRange; // Use the existing AnchorRange structure
}

// Retain your original AnchorRange structure
interface AnchorRange {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    text: string; // The text content of the range when the comment was made
}

// Internal representation of a comment, including the Monaco decoration ID
interface InternalComment extends ExternalComment {
    decorationId?: string; // Monaco decoration ID, managed by the frontend
}

const ADD_COMMENT_CMD: Command = { id: 'comment.add', label: 'Add Comment' };
const RESOLVE_COMMENT_CMD: Command = {
    id: 'comment.resolve',
    label: 'Resolve Comment'
};

const COMMENTS_SERVER_URL = `http://${window.location.hostname}:3100`; // Your backend server URL

/* ───────── Class ───────── */
@injectable()
export class HelloWorldContribution
    implements FrontendApplicationContribution, CommandContribution, MenuContribution {
    
    /* ===== DI ===== */
    constructor(
        @inject(EditorManager) private readonly editors: EditorManager,
        @inject(QuickPickService) private readonly pick: QuickPickService
    ) { console.log("HelloWorldContribution instance created:", this); }

    /* ===== State ===== */
    // Map to store comments by file path, and within each file, by comment ID
    // This allows for efficient lookup and management of decorations per file.
    // This map *is* your local representation of the JSON file.
    private commentsByFile = new Map<string, Map<string, InternalComment>>();
    private pollingIntervals = new Map<string, NodeJS.Timeout>();

    /* ───────── FrontendApplication ───────── */
    onStart(): void {
        /* 1) Load saved comments for the active editor and start polling */
        // When an editor is created (e.g., file opened), start polling for it.
        // this.editors.onCreated(widget => {
        //     const activeEditor = this.editors.activeEditor;
        //     if (activeEditor) {
        //         const monacoEditor = (activeEditor.editor as any)?.getControl?.();
        //         const file = activeEditor.editor.uri.path.toString();;
        //         if (monacoEditor) {
        //             this.startPolling(monacoEditor, file);
        //         }
        //     }
        // });

        // When the active editor changes, ensure polling is active for the new file.
        this.editors.onActiveEditorChanged(editorWidget => {
            if (editorWidget) {
                const activeEditor = this.editors.activeEditor;
                if (activeEditor) {
                    const monacoEditor = (activeEditor.editor as any)?.getControl?.();
                    const file = activeEditor.editor.uri.path.toString();;
                    if (monacoEditor) {
                        // Stop polling for previous active editor (if different) and start for the new one.
                        // This ensures we primarily poll for the actively viewed file.
                        this.pollingIntervals.forEach((interval, fileName) => {
                            if (fileName !== file) {
                                clearInterval(interval);
                                this.pollingIntervals.delete(fileName);
                            }
                        });
                        this.startPolling(monacoEditor, file);
                        monacoEditor.onMouseMove((e: monaco.editor.IEditorMouseEvent) => {
                            const pos = e.target.position;
                            if (!pos) {
                                return;
                            }

                            const model = monacoEditor.getModel();
                            if (!model) return;

                            const file = this.editors.activeEditor?.editor.uri.path.toString();
                            const comments = this.commentsByFile.get(file!);
                            if (!comments) return;

                            for (const comment of comments.values()) {
                                const range = this.locateAnchor(model, comment.anchor);
                                if (range.containsPosition(pos)) {
                                    this.showWidgetAt(range, comment, monacoEditor);
                                    return;
                                }
                            }

                            // 마우스가 밑줄 밖으로 나갔지만 위젯에 올라가 있으면 유지
                            const isHoveringWidget = this.isHoveringWidget();
                            if (!isHoveringWidget) {
                                this.hideWidget(monacoEditor);
                            }
                        });

                        // mouse leave 시 위젯 사라지게
                        monacoEditor.onMouseLeave(() => {
                            const isHoveringWidget = this.isHoveringWidget();
                            if (!isHoveringWidget) {
                                this.hideWidget(monacoEditor);
                            }
                        });
                    }
                }
            }
        });
    }
    
    /* ───────── CommandContribution ───────── */
    registerCommands(reg: CommandRegistry): void {
        reg.registerCommand(ADD_COMMENT_CMD, {
            execute: () => this.addComment(),
            isEnabled: () => true, // Always enabled if a selection exists
            isVisible: () => !!this.currentSelection() // Visible only if there's an active selection
        });
        reg.registerCommand(RESOLVE_COMMENT_CMD, {
            execute: () => this.resolveAtCursor(),
            isEnabled: () => true, // Can be refined to be enabled only if findCommentAtCursor returns true
            isVisible: () => true // Can be refined to be visible only if findCommentAtCursor returns true
        });
        reg.registerCommand({
            id: 'comment.applySuggestion',
            label: 'Apply Suggestion'
        }, {
            execute: (...args: any[]) => this.applySuggestionFromCommand(args)
        });
        reg.registerCommand({
            id: 'comment.resolve',
            label: 'Resolve Comment'
        }, {
            execute: (...args: any[]) => this.resolveFromCommand(args)
        });
    }
    

    /* ───────── MenuContribution ───────── */
    registerMenus(menu: MenuModelRegistry): void {
        menu.registerMenuAction(
            ['editor_context_menu', 'navigation'],
            { commandId: ADD_COMMENT_CMD.id, order: '1' }
        );
        menu.registerMenuAction(
            ['editor_context_menu', 'navigation'],
            { commandId: RESOLVE_COMMENT_CMD.id, order: '2' }
        );
    }

    private isHoveringWidget(): boolean {
        const widget = this.currentWidget?.getDomNode();
        if (!widget) return false;

        const hoveredElement = document.querySelector(':hover');
        return widget.contains(hoveredElement);
    }

    private async applySuggestionFromCommand(args: any[]): Promise<void> {
        console.log("we can recognize 1")
        const idArg = this.parseCommandArg(args, 'id');
        if (!idArg) return;

        const editor = this.editors.activeEditor;
        if (!editor) return;

        const monacoEditor = (editor.editor as any)?.getControl?.();
        const file = editor.editor.uri.path.toString();
        const model = monacoEditor?.getModel();
        if (!monacoEditor || !model) return;

        const comments = this.commentsByFile.get(file);
        if (!comments) return;

        const comment = comments.get(idArg);
        if (!comment) return;

        const range = this.locateAnchor(model, comment.anchor);

        // ✨ Replace range content
        model.pushEditOperations([], [{
            range,
            text: comment.suggestion
        }], () => null);

        // 🔁 Reuse existing resolve logic
        await this.deleteCommentById(comment.id, file);
        await this.fetchAndApplyComments(monacoEditor, file);
    }

    private async resolveFromCommand(args: any[]): Promise<void> {
        console.log("we can recognize 2")
        const idArg = this.parseCommandArg(args, 'id');
        if (!idArg) return;

        const editor = this.editors.activeEditor;
        if (!editor) return;

        const monacoEditor = (editor.editor as any)?.getControl?.();
        const file = editor.editor.uri.path.toString();
        if (!monacoEditor) return;

        await this.deleteCommentById(idArg, file);
        await this.fetchAndApplyComments(monacoEditor, file);
    }

    private parseCommandArg(args: any[], key: string): string | undefined {
        if (!args || args.length === 0 || typeof args[0] !== 'string') return;
        const parsed = new URLSearchParams(args[0].split('?')[1]);
        return parsed.get(key) ?? undefined;
    }

    private async deleteCommentById(id: string, file: string): Promise<void> {
    try {
        const res = await fetch(`${COMMENTS_SERVER_URL}/comments/${id}`, {
            method: 'DELETE',
        });
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Failed to delete comment: ${res.status} ${errorText}`);
        }
        this.commentsByFile.get(file)?.delete(id);
    } catch (err) {
        console.error('Delete failed:', err);
    }
}

private currentWidget: monaco.editor.IContentWidget | undefined;

private showWidgetAt(range: monaco.Range, comment: InternalComment, editor: monaco.editor.IStandaloneCodeEditor) {
    if (this.currentWidget) editor.removeContentWidget(this.currentWidget);

    const domNode = document.createElement('div');
    domNode.className = 'comment-tooltip';
    domNode.style.position = 'absolute';
    domNode.style.zIndex = '9999';
    domNode.style.background = 'white';
    domNode.style.border = '1px solid #e5e7eb'; // Tailwind의 border-gray-200
    domNode.style.borderRadius = '0.5rem';
    domNode.style.boxShadow = '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)';
    domNode.style.padding = '0.75rem'; // p-3
    domNode.style.maxWidth = '24rem'; // max-w-sm
    domNode.style.pointerEvents = 'auto';

    domNode.innerHTML = `
    <div style="display:flex; flex-direction:column; gap: 0.5rem;">
        <div style="font-weight:600; font-size: 0.875rem;">${comment.title}</div>
        <div style="font-size:0.75rem; color: #6b7280;">${comment.content}</div>
        ${
        comment.suggestion
            ? `<div>
                <div style="font-size:0.75rem; font-weight:500; margin-bottom:0.25rem;">Suggested Fix:</div>
                <pre style="font-size:0.75rem; background:#f3f4f6; padding:0.5rem; border-radius:0.375rem; border:1px solid #e5e7eb; overflow-x:auto;">${comment.suggestion}</pre>
            </div>`
            : ''
        }
        <div style="display:flex; gap: 0.5rem; margin-top:0.5rem;">
        <button id="apply" style="font-size:0.75rem; padding: 0.25rem 0.5rem; background-color: #10b981; color: white; border-radius: 0.25rem; border: none;">Apply</button>
        <button id="resolve" style="font-size:0.75rem; padding: 0.25rem 0.5rem; background-color: #f87171; color: white; border-radius: 0.25rem; border: none;">Resolve</button>
        </div>
    </div>
    `;

    domNode.querySelector('#apply')?.addEventListener('click', async () => {
        await this.applySuggestionDirect(comment, editor);
        this.hideWidget(editor);
    });

    domNode.querySelector('#resolve')?.addEventListener('click', async () => {
        await this.deleteCommentById(comment.id, comment.file);
        await this.fetchAndApplyComments(editor, comment.file);
        this.hideWidget(editor);
    });

    const widget: monaco.editor.IContentWidget = {
        getId: () => 'comment-widget',
        getDomNode: () => domNode,
        getPosition: () => ({ position: range.getStartPosition(), preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE,
    monaco.editor.ContentWidgetPositionPreference.BELOW] })
    };

    editor.addContentWidget(widget);
    this.currentWidget = widget;
}

private async applySuggestionDirect(comment: InternalComment, editor: monaco.editor.IStandaloneCodeEditor): Promise<void> {
    const model = editor.getModel();
    if (!model) return;

    const range = this.locateAnchor(model, comment.anchor);

    model.pushEditOperations([], [{
        range,
        text: comment.suggestion
    }], () => null);

    await this.deleteCommentById(comment.id, comment.file);
    await this.fetchAndApplyComments(editor, comment.file);
}

private hideWidget(editor: monaco.editor.IStandaloneCodeEditor) {
    if (this.currentWidget) {
        editor.removeContentWidget(this.currentWidget);
        this.currentWidget = undefined;
    }
}

    /* ───────── Actual Commands ───────── */
    private findCommentAtCursor(): InternalComment | undefined {
        const ctx = this.currentSelection();
        if (!ctx){return;} 
        const { monacoEditor, file } = ctx;
        const pos = monacoEditor.getPosition();
        const decorations2 = monacoEditor.getModel()?.getAllDecorations();
        console.log("really2")
        console.table(decorations2?.map(d => ({
            id: d.id,
            range: d.range.toString(),
            hover: JSON.stringify(d.options.hoverMessage),
            className: d.options.inlineClassName
        })));
        if (!pos){return;}
        // Crucial for collaboration: This method relies on `commentsByFile`,
        // which is kept in sync with the server's JSON via `fetchAndApplyComments`.
        const commentsForFile = this.commentsByFile.get(file);
        if (!commentsForFile){return;}

        const model = monacoEditor.getModel();
        if (!model){return;}

        for (const comment of commentsForFile.values()) {
            const range = this.locateAnchor(model, comment.anchor);
            if (range.containsPosition(pos)) {
                return comment;
            }
        }
        return undefined;
    }

    private async resolveAtCursor(): Promise<void> {
        const activeEditor = this.editors.activeEditor;
        if (activeEditor) {
            const monacoEditor = (activeEditor.editor as any)?.getControl?.();
            const file = activeEditor.editor.uri.path.toString();;
            if (monacoEditor) {
                await this.fetchAndApplyComments(monacoEditor, file);
            }
        }
        
        const commentToResolve = this.findCommentAtCursor();
        if (!commentToResolve) {
            console.warn('No comment at cursor to resolve.');
            return;
        }

        try {
            // 1. Send DELETE request to the server, targeting the comment by its ID.
            const res = await fetch(`${COMMENTS_SERVER_URL}/comments/${commentToResolve.id}`, {
                method: 'DELETE',
            });

            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(`Failed to delete comment on server: ${res.status} ${res.statusText} - ${errorText}`);
            }

            console.log(`Comment with ID ${commentToResolve.id} resolved on server.`);

            // 2. After successful deletion on the server, immediately refresh the client's view
            // by re-fetching all comments from the server. This ensures the client's state
            // (including decorations) is synchronized with the server's current `comment.json`.
            const activeEditor = this.editors.activeEditor;
            if (activeEditor) {
                const monacoEditor = (activeEditor.editor as any)?.getControl?.();
                const file = activeEditor.editor.uri.path.toString();;
                if (monacoEditor) {
                    await this.fetchAndApplyComments(monacoEditor, file);
                }
            }
        } catch (error) {
            console.error('Error resolving comment:', error);
            // Optionally, inform the user about the error.
        }
    }

    private async addComment(): Promise<void> {
        const ctx = this.currentSelection();
        if (!ctx) { return; }
        const { editorWidget, monacoEditor, file, range } = ctx;

        const pickedItem = await this.pick.show([
            { id: 'red underline', label: 'Red underline' },
            { id: 'orange underline', label: 'Orange underline' },
            { id: 'yellow underline', label: 'Yellow underline' },
            { id: 'gray underline', label: 'Gray underline' },
            { id: 'red highlight', label: 'Red highlight' },
            { id: 'orange highlight', label: 'Orange highlight' },
            { id: 'yellow highlight', label: 'Yellow highlight' },
            { id: 'gray highlight', label: 'Gray highlight' }
        ], { placeholder: 'Comment Type' });

        if (!pickedItem) return;

        const picked = pickedItem.id as Kind;
        const result = await new MultiInputDialog().open();
        if (!result) return;

        const { title, content, suggestion } = result;

        const newComment: ExternalComment = {
            id: `c-${Date.now()}`,
            file,
            type: picked,
            title,
            content,
            suggestion,
            anchor: this.makeAnchor(monacoEditor.getModel()!, range)
        };

        try {
            // 1. Send POST request to the server with the new comment data.
            const res = await fetch(`${COMMENTS_SERVER_URL}/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newComment)
            });

            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(`Failed to add comment to server: ${res.status} ${res.statusText} - ${errorText}`);
            }
            console.log('Comment successfully added to server.');

            // 2. After successful addition on the server, immediately refresh the client's view.
            // This ensures the new comment appears promptly and the local state is synchronized.
            await this.fetchAndApplyComments(monacoEditor, file);

        } catch (error) {
            console.error('Error adding comment:', error);
            // Optionally, inform the user about the error.
            return;
        }

        editorWidget.editor.focus();
    }

    /* ───────── Current selection ───────── */
    private currentSelection(): undefined | {
        editorWidget: EditorWidget;
        monacoEditor: monaco.editor.IStandaloneCodeEditor;
        file: string;
        range: monaco.Range;
    } {
        const activeEditor = this.editors.activeEditor;
        const editorWidget = this.editors.activeEditor;
        if(!editorWidget){return;}
        if (activeEditor) {
            const monacoEditor = (activeEditor.editor as any)?.getControl?.();
            if (monacoEditor) {
                const sel = monacoEditor.getSelection();
                if (!sel || sel.isEmpty()) { return; }
                return {
                    editorWidget,
                    monacoEditor,
                    file: activeEditor.editor.uri.path.toString(),
                    range: sel
                };
            }
        }
    }

    /* ───────── Decoration CSS Helper ───────── */
    private ensureCss(kind: Kind): string {
        const cls = `c-${kind.replace(/ /g, '-')}`;
        if (!document.querySelector(`style[data-comment-style="${cls}"]`)) {
            const style = document.createElement('style');
            style.setAttribute('data-comment-style', cls);
            style.textContent = {
                'red underline': `
                    .${cls}{
                    border-bottom: 3px solid red;
                    padding-bottom: 1px;
                    }
                    
                `,
                'orange underline': `
                    .${cls}{
                    border-bottom: 3px solid orange;
                    padding-bottom: 1px;
                    }
                `,
                'yellow underline': `
                    .${cls}{
                    border-bottom: 3px solid yellow;
                    padding-bottom: 1px;
                    }
                `,
                'gray underline': `
                    .${cls}{
                    border-bottom: 3px solid gray;
                    padding-bottom: 1px;
                    }
                `,
                'red highlight': `
                    .${cls}{
                        background-color: rgba(255, 0, 0, 0.25);
                    }
                `,
                'orange highlight': `
                    .${cls}{
                        background-color: rgba(255, 165, 0, 0.25);
                    }
                `,
                'yellow highlight': `
                    .${cls}{
                        background-color: rgba(255, 255, 0, 0.35);
                    }
                `,
                'gray highlight': `
                    .${cls}{
                        background-color: rgba(128, 128, 128, 0.25);
                    }
                `
            }[kind];
            document.head.appendChild(style);
        }
        return cls;
    }

    /* ───────── Anchor helpers ───────── */
    private makeAnchor(model: monaco.editor.ITextModel, r: monaco.Range): AnchorRange {
        return {
            startLineNumber: r.startLineNumber,
            startColumn: r.startColumn,
            endLineNumber: r.endLineNumber,
            endColumn: r.endColumn,
            text: model.getValueInRange(r)
        };
    }

    private locateAnchor(model: monaco.editor.ITextModel, a: AnchorRange): monaco.Range {
        const originalRange = new monaco.Range(
            a.startLineNumber, a.startColumn,
            a.endLineNumber, a.endColumn
        );
        const currentText = model.getValueInRange(originalRange);

        if (currentText === a.text) {
            return originalRange;
        }

        const searchStart = new monaco.Position(a.startLineNumber, a.startColumn);
        const match = model.findNextMatch(
            a.text, searchStart, false, false, null, true
        );

        if (match && match.range.startLineNumber >= a.startLineNumber) {
            return match.range;
        }

        const allMatches = model.findMatches(a.text, true, false, false, null, true);
        if (allMatches.length > 0) {
            const nearest = allMatches.reduce((prev, curr) => {
                const prevDist = Math.abs(prev.range.startLineNumber - a.startLineNumber);
                const currDist = Math.abs(curr.range.startLineNumber - a.startLineNumber);
                return currDist < prevDist ? curr : prev;
            });
            return nearest.range;
        }

        console.warn(`Could not locate comment anchor text reliably. Falling back to original coordinates for comment originally at ${a.startLineNumber}:${a.startColumn}.`);
        return originalRange;
    }

    /* ───────── Polling and Restoration ───────── */
    private async startPolling(editor: monaco.editor.IStandaloneCodeEditor, fileName: string): Promise<void> {
        // Clear any existing polling for this file to prevent multiple intervals.
        const existingInterval = this.pollingIntervals.get(fileName);
        if (existingInterval) {
            clearInterval(existingInterval);
        }

        // Immediately fetch and apply comments when polling starts for the file.
        await this.fetchAndApplyComments(editor, fileName);

        // Set up interval for periodic fetching (every 5 seconds).
        // This is the core mechanism for collaborative updates via JSON-based tracking.
        const intervalId = setInterval(async () => {
            await this.fetchAndApplyComments(editor, fileName);
        }, 5000); // Poll every 5 seconds

        console.log("hi3 ", this.commentsByFile)

        this.pollingIntervals.set(fileName, intervalId);

        // // Clear polling and local comments when the editor is disposed (e.g., file closed).
        // editor.onDidDispose(() => {
        //     clearInterval(this.pollingIntervals.get(fileName)!);
        //     this.pollingIntervals.delete(fileName);
        //     this.commentsByFile.delete(fileName); // Also clear comments for the disposed file
        // });
    }

    private async fetchAndApplyComments(editor: monaco.editor.IStandaloneCodeEditor, fileName: string): Promise<void> {
        try {
            // 1. Fetch comments from server
            const res = await fetch(`${COMMENTS_SERVER_URL}/comment.json`);
            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(`Failed to fetch comments: ${res.status} - ${errorText}`);
            }
            const externalComments: ExternalComment[] = await res.json();

            // 2. Filter comments for this file
            const commentsForFile = externalComments.filter(c => c.file === fileName);

            // 3. Extract previous decoration IDs from stored map (if any)
            const prevMap = this.commentsByFile.get(fileName);
            const oldIds = prevMap
                ? Array.from(prevMap.values()).map(c => c.decorationId!).filter(Boolean)
                : [];

            const actualDecorationIds = editor.getModel()?.getAllDecorations()?.map(d => d.id);
            console.log("Actual decorations in Monaco:", actualDecorationIds);

            // B. 우리가 제거하려는 decoration ID (from state)
            console.log("Old IDs from commentsByFile:", oldIds);

            // 4. Prepare new decorations
            const newMap = new Map<string, InternalComment>();
            const decorations: monaco.editor.IModelDeltaDecoration[] = [];

            for (const comment of commentsForFile) {
                const internalComment: InternalComment = { ...comment };
                const range = this.locateAnchor(editor.getModel()!, comment.anchor);

                decorations.push({
                    range,
                    options: {
                        inlineClassName: this.ensureCss(comment.type),
                        stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
                    }
                });

                newMap.set(comment.id, internalComment);
            }

            console.log('oldIds:', oldIds);
            console.log('decorations to apply:', decorations.length);

            const decorations1 = editor.getModel()?.getAllDecorations();
            console.log("really1")
            console.table(decorations1?.map(d => ({
                id: d.id,
                range: d.range.toString(),
                hover: JSON.stringify(d.options.hoverMessage),
                className: d.options.inlineClassName
            })));

            // 5. Apply delta decorations (Monaco will remove old + apply new)
            const allExistingDecorationIds = editor.getModel()?.getAllDecorations()?.map(d => d.id) ?? [];
            editor.deltaDecorations(allExistingDecorationIds, []);

            // 새로 추가
            const newIds = editor.deltaDecorations([], decorations);

            // 6. Sync decoration IDs to comment map
            let i = 0;
            for (const comment of newMap.values()) {
                comment.decorationId = newIds[i++];
            }

            // 7. Save updated map
            this.commentsByFile.set(fileName, newMap);

        } catch (err) {
            console.error('Error in fetchAndApplyComments:', err);
        }
    }
}

class MultiInputDialog {
    async open(): Promise<{ title: string; content: string; suggestion: string } | undefined> {
        return new Promise((resolve) => {
            const wrapper = document.createElement('div');
            wrapper.style.padding = '1em';
            wrapper.innerHTML = `
                <h3 style="margin-bottom: 0.5em;">Add Comment</h3>
                <label>Title:</label><br>
                <input type="text" id="multi-title" style="width: 100%; margin-bottom: 0.5em;"><br>
                <label>Content:</label><br>
                <textarea id="multi-content" rows="3" style="width: 100%; margin-bottom: 0.5em;"></textarea><br>
                <label>Suggestion:</label><br>
                <textarea id="multi-suggestion" rows="2" style="width: 100%; margin-bottom: 0.5em;"></textarea><br>
                <div style="text-align: right;">
                    <button id="multi-cancel">Cancel</button>
                    <button id="multi-submit">Submit</button>
                </div>
            `;

            const dialog = document.createElement('div');
            dialog.style.position = 'fixed';
            dialog.style.top = '50%';
            dialog.style.left = '50%';
            dialog.style.transform = 'translate(-50%, -50%)';
            dialog.style.zIndex = '9999';
            dialog.style.background = 'white';
            dialog.style.border = '1px solid #ccc';
            dialog.style.boxShadow = '0 2px 10px rgba(0,0,0,0.3)';
            dialog.style.padding = '1em';
            dialog.appendChild(wrapper);
            document.body.appendChild(dialog);

            const cleanup = () => {
                document.body.removeChild(dialog);
            };

            wrapper.querySelector('#multi-submit')?.addEventListener('click', () => {
                const title = (wrapper.querySelector('#multi-title') as HTMLInputElement).value.trim();
                const content = (wrapper.querySelector('#multi-content') as HTMLTextAreaElement).value.trim();
                const suggestion = (wrapper.querySelector('#multi-suggestion') as HTMLTextAreaElement).value.trim();

                if (title && content && suggestion) {
                    cleanup();
                    resolve({ title, content, suggestion });
                } else {
                    alert('All fields must be filled out.');
                }
            });

            wrapper.querySelector('#multi-cancel')?.addEventListener('click', () => {
                cleanup();
                resolve(undefined);
            });
        });
    }
}