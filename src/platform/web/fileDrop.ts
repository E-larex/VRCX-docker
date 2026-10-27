import { PhysicalPosition } from '@tauri-apps/api/window';

import type { FileDragDropEvent } from '../tauri/fileDrop';
import { request } from './http';

export function onBrowserFileDragDrop(
    handler: (event: FileDragDropEvent) => void
): () => void {
    let disposed = false;
    const enter = (event: DragEvent) => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        handler({
            type: 'enter',
            paths: ['browser-file'],
            position: new PhysicalPosition(event.clientX, event.clientY)
        });
    };
    const leave = (event: DragEvent) => {
        if (!event.relatedTarget) handler({ type: 'leave' });
    };
    const drop = (event: DragEvent) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files.length) return;
        event.preventDefault();
        handler({ type: 'leave' });
        void (async () => {
            const paths: string[] = [];
            for (const file of files) {
                const form = new FormData();
                form.append('file', file);
                paths.push(
                    (await request<{ path: string }>('/api/files/upload', form))
                        .path
                );
            }
            if (!disposed)
                handler({
                    type: 'drop',
                    paths,
                    position: new PhysicalPosition(event.clientX, event.clientY)
                });
        })().catch((error: unknown) => {
            console.error('Failed to upload dropped files:', error);
        });
    };
    window.addEventListener('dragover', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
        disposed = true;
        window.removeEventListener('dragover', enter);
        window.removeEventListener('dragleave', leave);
        window.removeEventListener('drop', drop);
    };
}
