import { request } from './http';

type FolderListing = {
    path: string;
    directories: { name: string; path: string }[];
};

export async function chooseDirectory(defaultPath = ''): Promise<string> {
    const chinese = navigator.language.startsWith('zh');
    const label = (en: string, zh: string) => (chinese ? zh : en);
    const dialog = document.createElement('dialog');
    dialog.className =
        'bg-card text-foreground border-border fixed m-auto max-h-[85vh] w-[min(32rem,90vw)] space-y-4 overflow-auto rounded-xl border p-6';
    dialog.setAttribute('aria-label', label('Choose a folder', '选择文件夹'));
    const heading = document.createElement('h2');
    heading.textContent = label('Choose a folder', '选择文件夹');
    const description = document.createElement('p');
    description.textContent = label(
        'Choose or create a server folder, or upload a copy of a local folder.',
        '选择或新建服务器文件夹，也可以上传本地文件夹的副本。'
    );
    const location = document.createElement('p');
    location.className = 'break-all font-mono text-sm';
    const navigation = document.createElement('div');
    const directories = document.createElement('div');
    directories.className = 'max-h-56 space-y-1 overflow-auto';
    directories.setAttribute('aria-label', label('Folders', '文件夹列表'));
    const actions = document.createElement('div');
    const form = document.createElement('form');
    form.hidden = true;
    form.className = 'space-y-3';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = label('Folder name', '文件夹名称');
    const name = document.createElement('input');
    name.type = 'text';
    name.required = true;
    name.className =
        'bg-background border-border block w-full rounded-md border p-2';
    nameLabel.append(name);
    const uploadSummary = document.createElement('p');
    const error = document.createElement('p');
    error.className = 'text-destructive break-words';
    error.setAttribute('role', 'alert');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    dialog.append(
        heading,
        description,
        location,
        navigation,
        directories,
        actions,
        form,
        error,
        status
    );

    return new Promise((resolve) => {
        let current = '';
        let loaded = false;
        let busy = false;
        let files: File[] = [];
        let mode: 'create' | 'upload' = 'create';
        const button = (
            parent: HTMLElement,
            text: string,
            action: () => void
        ) => {
            const element = document.createElement('button');
            element.type = 'button';
            element.textContent = text;
            element.className =
                'bg-secondary m-1 rounded-md px-3 py-2 disabled:opacity-50';
            element.onclick = action;
            parent.append(element);
            return element;
        };
        const update = () => {
            dialog.querySelectorAll('button, input').forEach((element) => {
                (element as HTMLButtonElement | HTMLInputElement).disabled =
                    busy;
            });
            up.disabled = busy || !loaded || !current;
            select.disabled = busy || !loaded || !current;
            create.disabled = busy || !loaded;
            upload.disabled = busy || !loaded;
            submit.disabled = busy || !loaded;
            dialog.setAttribute('aria-busy', String(busy));
            status.textContent = busy ? label('Working…', '处理中…') : '';
        };
        const run = async (action: () => Promise<void>) => {
            if (busy) return;
            busy = true;
            error.textContent = '';
            update();
            try {
                await action();
            } catch (cause) {
                error.textContent =
                    cause && typeof cause === 'object' && 'message' in cause
                        ? String(cause.message)
                        : label(
                              'Unable to complete the operation. Please retry.',
                              '操作失败，请重试。'
                          );
            } finally {
                busy = false;
                update();
            }
        };
        const finish = (path: string) => {
            resolve(path);
            dialog.close();
        };
        const load = async (path: string, initialPath?: string) => {
            const query = new URLSearchParams({ path });
            if (initialPath) query.set('initialPath', initialPath);
            const listing = await request<FolderListing>(
                `/api/files/folders?${query}`
            );
            current = listing.path;
            loaded = true;
            location.textContent = `web-files/${current}`;
            form.hidden = true;
            files = [];
            directories.replaceChildren();
            for (const folder of listing.directories) {
                const entry = button(directories, folder.name, () => {
                    void run(() => load(folder.path));
                });
                entry.classList.add(
                    'block',
                    'w-full',
                    'text-left',
                    'break-all'
                );
            }
            if (!listing.directories.length) {
                directories.textContent = label(
                    'No subfolders',
                    '没有子文件夹'
                );
            }
        };
        const up = button(navigation, label('Up', '返回上级'), () => {
            void run(() => load(current.split('/').slice(0, -1).join('/')));
        });
        button(navigation, label('Refresh', '刷新'), () => {
            void run(() => load(current));
        });
        const select = button(
            actions,
            label('Select this folder', '选择此文件夹'),
            () => {
                void run(async () => {
                    const result = await request<{ path: string }>(
                        '/api/files/folders/select',
                        { path: current }
                    );
                    finish(result.path);
                });
            }
        );
        const create = button(
            actions,
            label('New folder', '新建文件夹'),
            () => {
                mode = 'create';
                files = [];
                name.value = '';
                uploadSummary.textContent = '';
                submit.textContent = label('Create and select', '创建并选择');
                form.hidden = false;
                error.textContent = '';
                name.focus();
            }
        );
        const upload = button(
            actions,
            label('Upload folder', '上传文件夹'),
            () => {
                void run(async () => {
                    const selected = await new Promise<File[]>((done) => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.multiple = true;
                        input.webkitdirectory = true;
                        input.onchange = () =>
                            done(Array.from(input.files ?? []));
                        input.addEventListener('cancel', () => done([]));
                        input.click();
                    });
                    if (!selected.length) {
                        error.textContent = label(
                            'No files selected. Empty folders cannot be uploaded.',
                            '未选择文件，空文件夹无法上传。'
                        );
                        return;
                    }
                    mode = 'upload';
                    files = selected;
                    name.value =
                        files[0].webkitRelativePath.split('/')[0] || 'folder';
                    uploadSummary.textContent = label(
                        `${files.length} files selected`,
                        `已选择 ${files.length} 个文件`
                    );
                    submit.textContent = label(
                        'Upload and select',
                        '上传并选择'
                    );
                    form.hidden = false;
                }).then(() => {
                    if (!form.hidden) name.focus();
                });
            }
        );
        form.append(nameLabel, uploadSummary);
        const submit = button(
            form,
            label('Create and select', '创建并选择'),
            () => {}
        );
        submit.type = 'submit';
        form.onsubmit = (event) => {
            event.preventDefault();
            if (
                !name.value.trim() ||
                name.value === '.' ||
                name.value === '..' ||
                /[/\\\p{Cc}]/u.test(name.value) ||
                new TextEncoder().encode(name.value).length > 255
            ) {
                error.textContent = label(
                    'Enter a valid folder name (up to 255 bytes, without slashes or control characters).',
                    '请输入有效文件夹名称（不超过 255 字节，不含斜杠或控制字符）。'
                );
                return;
            }
            void run(async () => {
                let result: { path: string };
                if (mode === 'create') {
                    result = await request('/api/files/folders', {
                        parent: current,
                        name: name.value
                    });
                } else {
                    const data = new FormData();
                    for (const file of files) {
                        data.append(
                            'file',
                            file,
                            file.webkitRelativePath
                                .split('/')
                                .slice(1)
                                .join('/')
                        );
                    }
                    const query = new URLSearchParams({
                        parent: current,
                        name: name.value
                    });
                    result = await request(
                        `/api/files/directory?${query}`,
                        data
                    );
                }
                finish(result.path);
            });
        };
        button(dialog, label('Cancel', '取消'), () => finish(''));
        dialog.oncancel = (event) => {
            if (busy) event.preventDefault();
        };
        dialog.onclose = () => {
            dialog.remove();
            resolve('');
        };
        document.body.append(dialog);
        dialog.showModal();
        void run(() => load('', defaultPath));
    });
}
