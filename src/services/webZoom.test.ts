// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCurrentWebviewWindow } from '@/platform/web/window';
import { useShellStore } from '@/state/shellStore';

import { applyZoomLevel } from './themeService';

vi.mock('@/platform/host', () => ({ isWebHost: true }));
vi.mock('@/platform/tauri/client', async () => {
    const { getCurrentWebviewWindow } = await import('@/platform/web/window');
    return { tauriClient: { webview: getCurrentWebviewWindow() } };
});

afterEach(() => {
    document.documentElement.style.removeProperty('zoom');
    useShellStore.setState({ zoomLevel: null });
});

describe('web interface zoom', () => {
    it.each([30, 125, 300, null])(
        'restores normal layout when starting with saved zoom %s',
        async (savedZoom) => {
            document.documentElement.style.zoom = '3';
            useShellStore.setState({ zoomLevel: 300 });

            await applyZoomLevel(savedZoom);

            expect(document.documentElement.style.zoom).toBe('');
            expect(useShellStore.getState().zoomLevel).toBe(100);
        }
    );

    it('does not scale the document through the browser window adapter', async () => {
        await getCurrentWebviewWindow().setZoom(3);

        expect(document.documentElement.style.zoom).toBe('');
    });
});
