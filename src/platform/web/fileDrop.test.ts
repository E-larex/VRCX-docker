// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { onBrowserFileDragDrop } from './fileDrop';
import { request } from './http';

vi.mock('./http', () => ({ request: vi.fn() }));
afterEach(() => vi.clearAllMocks());

function drop(file: File) {
    const event = new Event('drop', { cancelable: true });
    Object.defineProperties(event, {
        dataTransfer: { value: { files: [file] } },
        clientX: { value: 10 },
        clientY: { value: 20 }
    });
    window.dispatchEvent(event);
    return event;
}

it('uploads browser files before passing server paths to the shared image UI', async () => {
    vi.mocked(request).mockResolvedValue({ path: '/data/web-files/photo.png' });
    const handler = vi.fn();
    const stop = onBrowserFileDragDrop(handler);
    try {
        const file = new File(['png'], 'photo.png', { type: 'image/png' });
        expect(drop(file).defaultPrevented).toBe(true);
        await vi.waitFor(() =>
            expect(handler).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'drop',
                    paths: ['/data/web-files/photo.png']
                })
            )
        );
        const [url, form] = vi.mocked(request).mock.calls[0];
        expect(url).toBe('/api/files/upload');
        expect((form as FormData).get('file')).toBe(file);
    } finally {
        stop();
    }
});

it('does not deliver a pending upload to an unmounted target', async () => {
    let finish!: (result: { path: string }) => void;
    vi.mocked(request).mockReturnValue(
        new Promise((resolve) => {
            finish = resolve;
        })
    );
    const handler = vi.fn();
    const stop = onBrowserFileDragDrop(handler);
    drop(new File(['png'], 'photo.png'));
    stop();
    finish({ path: '/data/web-files/photo.png' });
    await Promise.resolve();
    await Promise.resolve();
    expect(handler.mock.calls).toEqual([[{ type: 'leave' }]]);
});
