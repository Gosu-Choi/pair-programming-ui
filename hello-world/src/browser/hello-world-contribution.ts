import { injectable, inject } from '@theia/core/shared/inversify';
import {
    FrontendApplicationContribution,
    QuickPickService, SingleTextInputDialog
} from '@theia/core/lib/browser';
import {
    Command, CommandContribution, MenuContribution,
    CommandRegistry, MenuModelRegistry
} from '@theia/core/lib/common';
import { EditorManager, EditorWidget } from '@theia/editor/lib/browser';
import * as monaco from '@theia/monaco-editor-core/esm/vs/editor/editor.api';

/* ───────── Types and Constants ───────── */
type Kind = 'red underline' | 'blue underline' | 'background highlight' | 'sticky note';

// Interface for comments as they are stored in the external JSON file
interface ExternalComment {
    id: string;
    file: string;
    type: Kind;
    content: string;
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

    /* ───────── Actual Commands ───────── */
    private findCommentAtCursor(): InternalComment | undefined {
        const ctx = this.currentSelection();
        if (!ctx){console.log("1"); return;} 
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
        if (!pos){console.log("2"); return;}
        // Crucial for collaboration: This method relies on `commentsByFile`,
        // which is kept in sync with the server's JSON via `fetchAndApplyComments`.
        const commentsForFile = this.commentsByFile.get(file);
        if (!commentsForFile){console.log("3"); return;}

        const model = monacoEditor.getModel();
        if (!model){console.log("4"); return;}

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
            { id: 'blue underline', label: 'Blue underline' },
            { id: 'background highlight', label: 'Background highlight' },
            { id: 'sticky note', label: 'Sticky note' }
        ], { placeholder: 'Comment Type' });

        if (!pickedItem) return;

        const picked = pickedItem.id as Kind;

        const dlg = new SingleTextInputDialog({ title: 'Comment', placeholder: 'Comment text…' });
        const content = await dlg.open();
        if (!content) { return; }

        // Construct the new comment object with the `anchor` property.
        const newComment: ExternalComment = {
            id: `c-${Date.now()}`,
            file,
            type: picked,
            content,
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
                    .${cls}{text-decoration:underline wavy red;}
                `,
                'blue underline': `
                    .${cls}{text-decoration:underline wavy blue;}
                `,
                'background highlight': `
                    .${cls}{background-color:rgba(255,255,0,.35);}
                `,
                'sticky note': `
                    .${cls}{
                        background-color:rgba(255,255,0,.25);
                        font-style:italic;
                        color:orange;
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
        // First, try to find the exact text starting near the original position.
        const searchStartPosition = new monaco.Position(a.startLineNumber, a.startColumn);

        const foundMatch = model.findNextMatch(
            a.text,
            searchStartPosition,
            false, // no regex
            false, // no case sensitive
            null,  // no whole word (use null instead of false for wordSeparators)
            true   // capture matches
        );

        if (foundMatch && foundMatch.range.startLineNumber >= a.startLineNumber) {
            return foundMatch.range;
        }

        // If that fails, try finding it anywhere in the model (broader search).
        const broaderSearchMatch = model.findNextMatch(
            a.text,
            new monaco.Position(1, 1), // Start search from beginning of the file
            false, // no regex
            false, // no case sensitive
            null,  // no whole word
            true   // capture matches
        );

        if (broaderSearchMatch) {
            console.warn(`Comment text found at a different location for comment originally at ${a.startLineNumber}:${a.startColumn}.`);
            return broaderSearchMatch.range;
        }

        // As a last resort, fall back to the original coordinates.
        console.warn(`Could not locate comment anchor text reliably. Falling back to original coordinates for comment originally at ${a.startLineNumber}:${a.startColumn}.`);
        return new monaco.Range(a.startLineNumber, a.startColumn, a.endLineNumber, a.endColumn);
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

            // 4. Prepare new decorations
            const newMap = new Map<string, InternalComment>();
            const decorations: monaco.editor.IModelDeltaDecoration[] = [];

            for (const comment of commentsForFile) {
                const internalComment: InternalComment = { ...comment };
                const range = this.locateAnchor(editor.getModel()!, comment.anchor);

                decorations.push({
                    range,
                    options: {
                        hoverMessage: { value: comment.content },
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
            const newIds = editor.deltaDecorations(oldIds, decorations);

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