// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readFile, stat } from './cache';
import { invoke } from './core';

vi.mock('./http', () => ({ request: vi.fn(), logoutWebsite: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe('browser image upload adapters', () => {
    it('reads selected files through the confined server file endpoint', async () => {
        const fetch = vi.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
            headers: new Headers({ 'content-length': '3' })
        });
        vi.stubGlobal('fetch', fetch);
        const path = '/data/web-files/a b.png';
        expect(await stat(path)).toEqual({ isFile: true, size: 3 });
        expect(await readFile(path)).toEqual(new Uint8Array([1, 2, 3]));
        expect(fetch).toHaveBeenCalledWith(
            '/api/files/read/%2Fdata%2Fweb-files%2Fa%20b.png',
            { method: 'HEAD' }
        );
    });

    it('rejects inaccessible files and missing size metadata', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
        await expect(readFile('/etc/passwd')).rejects.toThrow(
            'File unavailable'
        );
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ ok: true, headers: new Headers() })
        );
        await expect(stat('/data/web-files/a.png')).rejects.toThrow(
            'File size unavailable'
        );
    });

    it('returns clipboard image bytes in the upstream wire format', async () => {
        vi.stubGlobal('navigator', {
            clipboard: {
                read: async () => [
                    {
                        types: ['image/png'],
                        getType: async () =>
                            new Blob(['png'], { type: 'image/png' })
                    }
                ]
            }
        });
        expect(await invoke('app__read_clipboard_image')).toEqual({
            fileName: 'clipboard.png',
            mimeType: 'image/png',
            dataBase64: 'cG5n'
        });
    });

    it('returns null when the browser clipboard has no image', async () => {
        vi.stubGlobal('navigator', { clipboard: { read: async () => [] } });
        expect(await invoke('app__read_clipboard_image')).toBeNull();
    });
});
