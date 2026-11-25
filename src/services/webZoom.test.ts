// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchGlobalShortcut } from '@/components/keyboard/shortcutDispatcher';
import { useAppZoomShortcuts } from '@/components/layout/useAppZoomShortcuts';
import { getCurrentWebviewWindow } from '@/platform/web/window';
import { usePreferencesStore } from '@/state/preferencesStore';
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

    it('leaves keyboard and wheel zoom to the browser with a saved desktop preference', () => {
        const previous = usePreferencesStore.getState().ctrlWheelZoom;
        usePreferencesStore.setState({ ctrlWheelZoom: true });
        const { unmount } = renderHook(useAppZoomShortcuts);
        try {
            for (const key of ['=', '+', '-', '0']) {
                const event = new KeyboardEvent('keydown', {
                    key,
                    ctrlKey: true,
                    cancelable: true
                });
                dispatchGlobalShortcut(event, false);
                expect(event.defaultPrevented).toBe(false);
            }
            const wheel = new WheelEvent('wheel', {
                ctrlKey: true,
                deltaY: 120,
                cancelable: true
            });
            expect(window.dispatchEvent(wheel)).toBe(true);
        } finally {
            unmount();
            usePreferencesStore.setState({ ctrlWheelZoom: previous });
        }
    });

    it('does not scale the document through the browser window adapter', async () => {
        await getCurrentWebviewWindow().setZoom(3);

        expect(document.documentElement.style.zoom).toBe('');
    });
});
