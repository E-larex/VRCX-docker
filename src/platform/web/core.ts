import { chooseDirectory } from './folderPicker';
import { request, logoutWebsite } from './http';

export type InvokeArgs = Record<string, unknown>;
export const isTauri = () => false;
export function convertFileSrc(path: string, _protocol?: string): string {
    // Upstream consumers append query parameters such as ?v= for cache versions.
    return `/api/files/read/${encodeURIComponent(path)}`;
}
function downloadBlob(content: BlobPart, name: string, type: string): string {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return name;
}
async function pickFiles(
    multiple: boolean,
    extensions: string
): Promise<string[]> {
    const files = await new Promise<File[]>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = multiple;
        input.accept = extensions;
        input.onchange = () => resolve(Array.from(input.files ?? []));
        input.addEventListener('cancel', () => resolve([]));
        input.click();
    });
    const paths: string[] = [];
    for (const file of files) {
        const form = new FormData();
        form.append('file', file);
        paths.push(
            (await request<{ path: string }>('/api/files/upload', form)).path
        );
    }
    return paths;
}
async function uploadLegacyDirectory(): Promise<string> {
    const files = await new Promise<File[]>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.webkitdirectory = true;
        input.onchange = () => resolve(Array.from(input.files ?? []));
        input.addEventListener('cancel', () => resolve([]));
        input.click();
    });
    if (!files.length) return '';
    const form = new FormData();
    for (const file of files) {
        const path = file.webkitRelativePath.split('/').slice(1).join('/');
        if (
            ![
                'VRCX.sqlite3',
                'VRCX.sqlite3-wal',
                'VRCX.sqlite3-shm',
                'VRCX.json',
                'VRCX'
            ].includes(path)
        )
            continue;
        form.append('file', file, path);
    }
    return (
        await request<{ path: string }>(
            '/api/files/directory?legacy=true',
            form
        )
    ).path;
}
async function watchDownload(path: string): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const result = await request<{ ready: boolean }>(
            `/api/files/ready?path=${encodeURIComponent(path)}`
        );
        if (!result.ready) continue;
        const link = document.createElement('a');
        link.href = `${convertFileSrc(path)}?download=true`;
        link.download = '';
        link.click();
        return;
    }
    throw new Error('Export timed out; check the task status before retrying.');
}
async function openResource(path: string, folder: boolean): Promise<void> {
    if (!folder) {
        const link = document.createElement('a');
        link.href = `${convertFileSrc(path)}?download=true`;
        link.download = '';
        link.click();
        return;
    }
    const files = await request<{ name: string; path: string }[]>(
        `/api/files/list?path=${encodeURIComponent(path)}`
    );
    const dialog = document.createElement('dialog');
    dialog.className =
        'bg-card text-foreground border-border fixed m-auto max-h-[80vh] min-w-72 overflow-auto rounded-xl border p-6';
    const title = document.createElement('h2');
    title.textContent = navigator.language.startsWith('zh')
        ? '服务器文件夹'
        : 'Server folder';
    dialog.append(title);
    for (const file of files) {
        const link = document.createElement('a');
        link.className = 'text-primary block py-2 underline';
        link.textContent = file.name;
        link.href = `${convertFileSrc(file.path)}?download=true`;
        link.download = '';
        dialog.append(link);
    }
    if (!files.length)
        dialog.append(
            document.createTextNode(
                navigator.language.startsWith('zh') ? '没有文件' : 'No files'
            )
        );
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'bg-secondary mt-4 rounded-md px-3 py-2';
    close.textContent = navigator.language.startsWith('zh') ? '关闭' : 'Close';
    close.onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    dialog.append(close);
    document.body.append(dialog);
    dialog.showModal();
}
const shellNoops = new Set([
    'app__set_tray_icon_notification',
    'app__set_taskbar_overlay_notification',
    'app__refresh_tray_menu',
    'app__language_changed',
    'app__ensure_main_window',
    'app__confirm_linux_rendering',
    'app__runtime_discord_reconcile_request',
    'app__set_startup',
    'app__desktop_notification',
    'app__auth_failure_notification_show'
]);
export async function invoke<T>(
    command: string,
    args: InvokeArgs = {}
): Promise<T> {
    let result: unknown;
    if (shellNoops.has(command)) return null as T;
    switch (command) {
        case 'app__is_game_running':
            return false as T;
        case 'app__host_tts_voices':
            return [] as T;
        case 'log_watcher__get_current_location':
            return '' as T;
        case 'app__open_ugc_photos_folder':
            await openResource(String(args.ugcPath), true);
            return true as T;
        case 'app__copy_image_to_clipboard': {
            const response = await fetch(convertFileSrc(String(args.path)));
            if (!response.ok) throw new Error('Image unavailable');
            const bitmap = await createImageBitmap(await response.blob());
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Image conversion unavailable');
            context.drawImage(bitmap, 0, 0);
            bitmap.close();
            const png = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob(
                    (blob) =>
                        blob
                            ? resolve(blob)
                            : reject(new Error('Image conversion failed')),
                    'image/png'
                );
            });
            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': png })
            ]);
            return null as T;
        }
        case 'app__open_folder_and_select_item':
            await openResource(String(args.path), Boolean(args.isFolder));
            return null as T;
        case 'app__open_link': {
            const url = new URL(String(args.url));
            if (!['https:', 'http:', 'mailto:'].includes(url.protocol))
                throw new Error('Unsupported link protocol');
            window.open(url.href, '_blank', 'noopener,noreferrer');
            return null as T;
        }
        case 'app__open_discord_profile':
            window.open(
                `https://discord.com/users/${encodeURIComponent(String(args.discordId))}`,
                '_blank',
                'noopener,noreferrer'
            );
            return null as T;
        case 'app__get_clipboard':
            return (await navigator.clipboard.readText()) as T;
        case 'app__exit_application':
            await logoutWebsite();
            return null as T;
        case 'app__restart_application':
            window.location.reload();
            return null as T;
        case 'app__drain_pending_deep_links':
            return [] as T;
        case 'app__take_pending_desktop_notification_activation':
            return null as T;
        case 'app__deep_link_registration_status':
            return null as T;
        case 'app__get_linux_rendering':
            return null as T;
        case 'app__get_sidebar_auto_hide':
            return { enabled: false, failed: false } as T;
        case 'app__get_tray_shortcut':
            return { binding: null, status: 'unsupported' } as T;
        case 'app__take_tray_shortcut_startup_failure':
            return false as T;
        case 'app__open_file_selector_dialog':
            result =
                (
                    await pickFiles(
                        false,
                        args.defaultExt
                            ? `.${String(args.defaultExt).replace(/^\./, '')}`
                            : ''
                    )
                )[0] ?? '';
            break;
        case 'app__open_background_image_files_selector_dialog':
            result = await pickFiles(true, 'image/*');
            break;
        case 'app__open_folder_selector_dialog':
            result = await chooseDirectory(String(args.defaultPath ?? ''));
            break;
        case 'app__get_legacy_vrcx_force_migration_status': {
            result = await request<T>(`/api/invoke/${command}`, args);
            if (
                result &&
                typeof result === 'object' &&
                'available' in result &&
                !result.available
            ) {
                const path = await uploadLegacyDirectory();
                if (path)
                    result = await request<T>(`/api/invoke/${command}`, args);
            }
            break;
        }
        case 'app__save_file_selector_dialog': {
            let name = String(args.defaultName || 'export');
            const ext = String(args.defaultExt || '').replace(/^\./, '');
            if (ext && !name.endsWith(`.${ext}`)) name += `.${ext}`;
            const { path } = await request<{ path: string }>(
                '/api/files/reserve',
                { name }
            );
            void watchDownload(path).catch(console.error);
            result = path;
            break;
        }
        case 'app__open_calendar_file':
        case 'app__save_calendar_file':
            result = downloadBlob(
                String(args.icsContent),
                String(args.defaultName || 'event.ics'),
                'text/calendar'
            );
            break;
        case 'app__save_vrc_reg_json_file':
            result = downloadBlob(
                String(args.json),
                String(args.defaultName || 'export.json'),
                'application/json'
            );
            break;
        case 'app__save_image_file': {
            const encoded = String(args.base64Data).split(',').pop() ?? '';
            result = downloadBlob(
                Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
                String(args.defaultName || 'image.png'),
                'application/octet-stream'
            );
            break;
        }
        default:
            result = await request<T>(
                `/api/invoke/${encodeURIComponent(command)}`,
                args
            );
    }
    return result as T;
}
