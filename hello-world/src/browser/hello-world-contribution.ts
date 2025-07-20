import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser';
import * as monaco from '@theia/monaco-editor-core/esm/vs/editor/editor.api';

type DecorationKind = 'red underline' | 'blue underline' | 'background highlight' | 'sticky note';

interface CommentJson {
    file: string;
    type: DecorationKind;
    content: string;
    range: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
    };
}

@injectable()
export class HelloWorldContribution implements FrontendApplicationContribution {
    private currentDecorations: string[] = [];

    constructor(private readonly editorManager: EditorManager) { }

    onStart(): void {
        console.log('[HelloWorld] Decoration polling 시작');

        this.editorManager.onCreated(editorWidget => {
            const editor = editorWidget.editor as any;
            const monacoEditor = editor.getControl();
            const fileName = editor.uri.path.base;

            this.startPolling(monacoEditor, fileName);
        });
    }

    private startPolling(editor: monaco.editor.IStandaloneCodeEditor, fileName: string): void {
        const fetchAndApply = async () => {
            try {
                const res = await fetch(`http://${window.location.hostname}:3100/comment.json`);
                if (!res.ok) throw new Error('comment.json fetch 실패');
                const comments: CommentJson[] = await res.json();

                const matching = comments.filter(comment => comment.file === fileName);
                if (matching.length === 0) return;

                // 데코레이션 초기화
                this.currentDecorations = editor.deltaDecorations(this.currentDecorations, []);

                const decorations: monaco.editor.IModelDeltaDecoration[] = matching.map(comment => {
                    const range = new monaco.Range(
                        comment.range.startLine,
                        comment.range.startColumn,
                        comment.range.endLine,
                        comment.range.endColumn
                    );

                    return {
                        range,
                        options: {
                            hoverMessage: { value: comment.content },
                            inlineClassName: this.createStyleClass(comment.type)
                        }
                    };
                });


                this.currentDecorations = editor.deltaDecorations([], decorations);

            } catch (error) {
                console.error('comment fetch 오류:', error);
            }
        };

        fetchAndApply(); // 최초 호출
        setInterval(fetchAndApply, 10000); // 주기적 호출
    }

    private createStyleClass(type: DecorationKind): string {
        const classNameMap: Record<DecorationKind, string> = {
            'red underline': 'decoration-red-underline',
            'blue underline': 'decoration-blue-underline',
            'background highlight': 'decoration-background-highlight',
            'sticky note': 'decoration-sticky-note'
        };

        const className = classNameMap[type];
        if (!className) return '';

        if (!document.querySelector(`style[data-comment-style="${className}"]`)) {
            const style = document.createElement('style');
            style.setAttribute('data-comment-style', className);
            style.innerHTML = `
                .${className} {
                    text-decoration: ${type === 'red underline' ? 'underline wavy red'
                    : type === 'blue underline' ? 'underline wavy blue'
                        : 'none'};
                    background-color: ${type === 'background highlight' || type === 'sticky note'
                    ? 'rgba(255,255,0,0.3)' : 'transparent'};
                    font-style: ${type === 'sticky note' ? 'italic' : 'normal'};
                    color: ${type === 'sticky note' ? 'orange' : 'inherit'};
                }
            `;
            document.head.appendChild(style);
        }

        return className;
    }
}
