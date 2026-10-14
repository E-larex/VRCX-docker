import { fireEvent, screen, waitFor } from '@testing-library/react';
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chooseDirectory } from './folderPicker';
import { request } from './http';

vi.mock('./http', () => ({ request: vi.fn() }));
const api = vi.mocked(request);
const button = (name: string) =>
    screen.getByRole('button', { name }) as HTMLButtonElement;
async function ready() {
    await waitFor(() => expect(button('Refresh').disabled).toBe(false));
}
beforeEach(() => {
    api.mockReset();
    Object.defineProperties(HTMLDialogElement.prototype, {
        showModal: {
            configurable: true,
            value: function (this: HTMLDialogElement) {
                this.open = true;
            }
        },
        close: {
            configurable: true,
            value: function (this: HTMLDialogElement) {
                this.open = false;
                this.dispatchEvent(new Event('close'));
            }
        }
    });
    api.mockResolvedValue({ path: '', directories: [] });
});
afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

describe('server folder picker', () => {
    it('uses the default path, navigates and validates the selected folder on the server', async () => {
        api.mockResolvedValueOnce({
            path: 'backups',
            directories: [{ name: 'nested', path: 'backups/nested' }]
        });
        const result = chooseDirectory('/data/web-files/backups');
        await ready();
        expect(api.mock.calls[0][0]).toBe(
            '/api/files/folders?path=&initialPath=%2Fdata%2Fweb-files%2Fbackups'
        );
        api.mockResolvedValueOnce({ path: 'backups/nested', directories: [] });
        fireEvent.click(button('nested'));
        await ready();
        expect(screen.getByText('web-files/backups/nested')).toBeTruthy();
        api.mockResolvedValueOnce({ path: 'backups', directories: [] });
        fireEvent.click(button('Up'));
        await ready();
        expect(api).toHaveBeenLastCalledWith('/api/files/folders?path=backups');
        api.mockResolvedValueOnce({ path: '/data/web-files/backups' });
        fireEvent.click(button('Select this folder'));
        await expect(result).resolves.toBe('/data/web-files/backups');
        expect(api).toHaveBeenLastCalledWith('/api/files/folders/select', {
            path: 'backups'
        });
        expect(document.querySelector('dialog')).toBeNull();
    });

    it('disables root selection and returns an empty path on cancellation', async () => {
        const result = chooseDirectory('/invalid/path');
        await ready();
        expect(button('Select this folder').disabled).toBe(true);
        expect(button('Up').disabled).toBe(true);
        fireEvent.click(button('Cancel'));
        await expect(result).resolves.toBe('');
    });

    it('retains the name after a conflict and prevents duplicate requests', async () => {
        const result = chooseDirectory();
        await ready();
        fireEvent.click(button('New folder'));
        const name = screen.getByLabelText('Folder name') as HTMLInputElement;
        fireEvent.change(name, { target: { value: '我的 备份' } });
        let rejectRequest!: (reason: unknown) => void;
        api.mockReturnValueOnce(
            new Promise((_, reject) => {
                rejectRequest = reject;
            })
        );
        fireEvent.click(button('Create and select'));
        expect(button('Create and select').disabled).toBe(true);
        expect(button('Cancel').disabled).toBe(true);
        const escape = new Event('cancel', { cancelable: true });
        document.querySelector('dialog')!.dispatchEvent(escape);
        expect(escape.defaultPrevented).toBe(true);
        fireEvent.click(button('Create and select'));
        expect(api).toHaveBeenCalledTimes(2);
        rejectRequest({
            message: 'A file or folder with this name already exists'
        });
        await ready();
        expect(name.value).toBe('我的 备份');
        expect(screen.getByRole('alert').textContent).toContain(
            'already exists'
        );
        fireEvent.change(name, { target: { value: '新备份' } });
        api.mockResolvedValueOnce({ path: '/data/web-files/新备份' });
        fireEvent.click(button('Create and select'));
        await expect(result).resolves.toBe('/data/web-files/新备份');
        expect(api).toHaveBeenLastCalledWith('/api/files/folders', {
            parent: '',
            name: '新备份'
        });
    });

    it('rejects invalid names without issuing a request', async () => {
        const result = chooseDirectory();
        await ready();
        fireEvent.click(button('New folder'));
        for (const value of [
            ' ',
            '..',
            '../escape',
            'a/b',
            'a\\b',
            'a\u0001b'
        ]) {
            fireEvent.change(screen.getByLabelText('Folder name'), {
                target: { value }
            });
            fireEvent.submit(document.querySelector('form')!);
            expect(screen.getByRole('alert').textContent).toContain(
                'valid folder name'
            );
        }
        expect(api).toHaveBeenCalledTimes(1);
        fireEvent.click(button('Cancel'));
        await result;
    });

    it('names an upload and preserves relative paths and selected files across retries', async () => {
        api.mockResolvedValueOnce({ path: 'images', directories: [] });
        const result = chooseDirectory();
        await ready();
        const file = new File(['test image'], 'pic.png', { type: 'image/png' });
        Object.defineProperty(file, 'webkitRelativePath', {
            value: 'Local Photos/sub/pic.png'
        });
        vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(
            function (this: HTMLInputElement) {
                Object.defineProperty(this, 'files', { value: [file] });
                this.dispatchEvent(new Event('change'));
            }
        );
        fireEvent.click(button('Upload folder'));
        await ready();
        const name = screen.getByLabelText('Folder name') as HTMLInputElement;
        expect(name.value).toBe('Local Photos');
        fireEvent.change(name, { target: { value: '背景 图片' } });
        api.mockRejectedValueOnce({ message: 'Upload failed' });
        fireEvent.click(button('Upload and select'));
        await ready();
        expect(name.value).toBe('背景 图片');
        expect(screen.getByRole('alert').textContent).toBe('Upload failed');
        const [url, data] = api.mock.calls.at(-1)!;
        expect(url).toBe(
            '/api/files/directory?parent=images&name=%E8%83%8C%E6%99%AF+%E5%9B%BE%E7%89%87'
        );
        expect(((data as FormData).get('file') as File).name).toBe(
            'sub/pic.png'
        );
        api.mockResolvedValueOnce({ path: '/data/web-files/images/背景 图片' });
        fireEvent.click(button('Upload and select'));
        await expect(result).resolves.toBe('/data/web-files/images/背景 图片');
    });

    it('handles empty local folders and retries a failed directory listing', async () => {
        api.mockRejectedValueOnce({ message: 'Network unavailable' });
        const result = chooseDirectory();
        await ready();
        expect(button('New folder').disabled).toBe(true);
        expect(screen.getByRole('alert').textContent).toBe(
            'Network unavailable'
        );
        fireEvent.click(button('Refresh'));
        await ready();
        vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(
            function (this: HTMLInputElement) {
                this.dispatchEvent(new Event('change'));
            }
        );
        fireEvent.click(button('Upload folder'));
        await ready();
        expect(screen.getByRole('alert').textContent).toContain(
            'Empty folders'
        );
        expect(api).toHaveBeenCalledTimes(2);
        fireEvent.click(button('Cancel'));
        await result;
    });
});
