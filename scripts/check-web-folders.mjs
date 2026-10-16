// Run after npm run build:web and cargo build --locked -p vrcx-0-web.
// Requires Playwright with Chromium. VRCX_TEST_PLAYWRIGHT_MODULE and VRCX_TEST_CHROMIUM
// can point to an external Playwright installation and Chromium executable.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const { chromium } = await import(
    process.env.VRCX_TEST_PLAYWRIGHT_MODULE || 'playwright'
);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'vrcx-folder-browser-'));
const data = path.join(temporary, 'data');
const password = randomBytes(24).toString('hex');
async function freePort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
    );
    return port;
}
const backendPort = await freePort();
const frontendPort = await freePort();
const origin = `http://127.0.0.1:${frontendPort}`;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
let backend;
let vite;
let browser;
async function startBackend() {
    backend = spawn(
        path.join(repo, 'target/debug/vrcx-0-web'),
        ['--data-dir', data],
        {
            cwd: repo,
            env: {
                ...Object.fromEntries(
                    Object.entries(process.env).filter(
                        ([key]) => !key.startsWith('VRCX_')
                    )
                ),
                VRCX_WEB_BIND: `127.0.0.1:${backendPort}`,
                VRCX_WEB_ORIGIN: origin,
                VRCX_WEB_PASSWORD: password,
                VRCX_WEB_DIST: path.join(repo, 'dist'),
                VRCX_LEGACY_DATA_DIR: path.join(temporary, 'legacy')
            },
            stdio: 'ignore'
        }
    );
    for (let attempt = 0; attempt < 100; attempt++) {
        if (backend.exitCode !== null)
            throw new Error('Isolated backend exited before startup');
        if (
            await fetch(`${backendOrigin}/health`)
                .then((r) => r.ok)
                .catch(() => false)
        )
            return;
        await delay(100);
    }
    throw new Error('Isolated backend startup timed out');
}
async function stopBackend() {
    if (!backend || backend.exitCode !== null) return;
    const exited = once(backend, 'exit');
    backend.kill('SIGTERM');
    const timeout = setTimeout(() => backend.kill('SIGKILL'), 5000);
    try {
        await exited;
    } finally {
        clearTimeout(timeout);
    }
}
try {
    await mkdir(data);
    await startBackend();
    vite = await createServer({
        root: repo,
        mode: 'web',
        logLevel: 'error',
        server: {
            host: '127.0.0.1',
            port: frontendPort,
            strictPort: true,
            proxy: { '/api': backendOrigin, '/health': backendOrigin }
        },
        plugins: [
            {
                name: 'folder-browser-test',
                configureServer(server) {
                    server.middlewares.use(
                        '/__folder_test',
                        (_request, response) => {
                            response.setHeader('Content-Type', 'text/html');
                            response.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>
                        <script type="module">
                        import '/src/styles/globals.css';
                        import { invoke } from '/src/platform/web/core.ts';
                        window.openPicker = (defaultPath = '') => {
                            window.selectedPath = null;
                            void invoke('app__open_folder_selector_dialog', {defaultPath}).then(path => window.selectedPath = path);
                        };
                        window.chooseBackground = async () => {
                            const { chooseBackgroundImageFiles } = await import('/src/services/background-image/backgroundImageService.ts');
                            const { useBackgroundImageStore } = await import('/src/state/backgroundImageStore.ts');
                            await chooseBackgroundImageFiles();
                            const image = new Image();
                            image.id = 'uploaded-background';
                            image.src = useBackgroundImageStore.getState().snapshot.imageUrl;
                            document.body.append(image);
                        };
                        </script></body></html>`);
                        }
                    );
                }
            }
        ]
    });
    await vite.listen();
    browser = await chromium.launch({
        executablePath: process.env.VRCX_TEST_CHROMIUM,
        headless: true,
        args: ['--no-sandbox']
    });
    const context = await browser.newContext({ locale: 'zh-CN' });
    const login = async () => {
        const response = await context.request.post(`${origin}/api/login`, {
            headers: { Origin: origin, 'X-VRCX-Web': '1' },
            data: { password }
        });
        assert.equal(response.status(), 200);
    };
    await login();
    const page = await context.newPage();
    const open = async (defaultPath = '') => {
        await page.goto(`${origin}/__folder_test`);
        await page.waitForFunction(
            () => typeof window.openPicker === 'function'
        );
        await page.evaluate((value) => window.openPicker(value), defaultPath);
        await page.locator('dialog[aria-busy="false"]').waitFor();
    };
    const click = (name) =>
        page.getByRole('button', { name, exact: true }).click();
    const selected = async () => {
        await page.waitForFunction(() => window.selectedPath !== null);
        return page.evaluate(() => window.selectedPath);
    };
    await open();
    assert.equal(
        await page
            .getByRole('button', { name: '选择此文件夹', exact: true })
            .isDisabled(),
        true
    );
    await click('新建文件夹');
    await page.getByLabel('文件夹名称').fill('我的备份');
    await click('创建并选择');
    const parent = await selected();
    assert.equal(parent, path.join(data, 'web-files/我的备份'));
    await open(parent);
    assert.equal(
        await page
            .locator('dialog')
            .getByText('web-files/我的备份', { exact: true })
            .count(),
        1
    );
    await click('新建文件夹');
    await page.getByLabel('文件夹名称').fill('每日');
    await click('创建并选择');
    assert.equal(await selected(), path.join(parent, '每日'));

    await open();
    await click('新建文件夹');
    await page.getByLabel('文件夹名称').fill('我的备份');
    await click('创建并选择');
    await page
        .getByRole('alert')
        .filter({ hasText: 'already exists' })
        .waitFor();
    assert.equal(await page.getByLabel('文件夹名称').inputValue(), '我的备份');
    await click('取消');
    assert.equal(await selected(), '');

    const local = path.join(temporary, 'Local Photos');
    await mkdir(path.join(local, 'nested'), { recursive: true });
    await writeFile(
        path.join(local, 'nested/sample.txt'),
        'synthetic upload contents'
    );
    await open(parent);
    const chooserPromise = page.waitForEvent('filechooser');
    await click('上传文件夹');
    await (await chooserPromise).setFiles(local);
    await page.getByLabel('文件夹名称').waitFor();
    assert.equal(
        await page.getByLabel('文件夹名称').inputValue(),
        'Local Photos'
    );
    await page.getByLabel('文件夹名称').fill('上传 内容');
    await click('上传并选择');
    const uploaded = await selected();
    assert.equal(uploaded, path.join(parent, '上传 内容'));
    assert.equal(
        await readFile(path.join(uploaded, 'nested/sample.txt'), 'utf8'),
        'synthetic upload contents'
    );

    await stopBackend();
    await startBackend();
    await login();
    await open(parent);
    await click('上传 内容');
    await page.locator('dialog[aria-busy="false"]').waitFor();
    await click('nested');
    await page.locator('dialog[aria-busy="false"]').waitFor();
    await click('返回上级');
    await page.locator('dialog[aria-busy="false"]').waitFor();
    await page.screenshot({ path: '/tmp/vrcx-folder-picker.png' });
    await click('选择此文件夹');
    assert.equal(await selected(), uploaded);
    await open('/etc');
    assert.equal(
        await page
            .locator('dialog')
            .getByText('web-files/', { exact: true })
            .count(),
        1
    );
    await page.keyboard.press('Escape');
    assert.equal(await selected(), '');

    // Exercise the real background service, including its appended cache version.
    const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 2;
        return canvas.toDataURL('image/png').split(',')[1];
    });
    const backgroundChooser = page.waitForEvent('filechooser');
    await page.evaluate(() => {
        void window.chooseBackground();
    });
    await (
        await backgroundChooser
    ).setFiles({
        name: '背景 ?#%.png',
        mimeType: 'image/png',
        buffer: Buffer.from(png, 'base64')
    });
    await page.locator('#uploaded-background').waitFor({ state: 'attached' });
    await page.waitForFunction(
        () => document.querySelector('#uploaded-background').complete
    );
    assert.equal(
        await page
            .locator('#uploaded-background')
            .evaluate((image) => image.naturalWidth),
        2
    );
    const imageUrl = await page
        .locator('#uploaded-background')
        .getAttribute('src');
    const download = await context.request.get(
        `${origin}${imageUrl}&download=true`
    );
    assert.equal(download.status(), 200);
    assert.match(download.headers()['content-disposition'], /^attachment;/);
    console.log(
        'PASS: folders, restart persistence, uploaded background rendering and download (synthetic credentials).'
    );
} finally {
    await browser?.close();
    await vite?.close();
    await stopBackend();
    await rm(temporary, { recursive: true, force: true });
}
