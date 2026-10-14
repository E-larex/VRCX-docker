// Run after npm run build:web and cargo build --locked -p vrcx-0-web.
// Requires Playwright with Chromium. VRCX_TEST_PLAYWRIGHT_MODULE and VRCX_TEST_CHROMIUM
// can point to an external Playwright installation and Chromium executable.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
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
const temporary = await mkdtemp(path.join(tmpdir(), 'vrcx-about-browser-'));
const data = path.join(temporary, 'data');
const password = 'synthetic-about-browser-password';
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
            proxy: { '/api': { target: backendOrigin, changeOrigin: false } }
        },
        plugins: [
            {
                name: 'about-browser-check',
                configureServer(server) {
                    server.middlewares.use(
                        '/__about_test',
                        async (_request, response, next) => {
                            try {
                                const html = await server.transformIndexHtml(
                                    '/__about_test',
                                    `<!doctype html>
                        <html><head><meta charset="utf-8"></head><body><div id="root"></div>
                        <script type="module">
                        import React from 'react';
                        import { createRoot } from 'react-dom/client';
                        import { BrowserRouter } from 'react-router';
                        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
                        import { I18nextProvider } from 'react-i18next';
                        import i18n, { setI18nLanguage } from '/src/services/i18nService.ts';
                        import { AppMenuBar } from '/src/components/layout/AppMenuBar.tsx';
                        import { SettingsPage } from '/src/features/settings/SettingsPage.tsx';
                        import { LoginPageFooter } from '/src/features/auth/components/LoginPageFooter.tsx';
                        import { DatabaseUpgradeDialog } from '/src/components/hosts/system-dialogs/DatabaseUpgradeDialog.tsx';
                        import { useRuntimeStore } from '/src/state/runtimeStore.ts';
                        import { useShellStore } from '/src/state/shellStore.ts';
                        import '/src/styles/globals.css';
                        window.setLanguage = setI18nLanguage;
                        window.openedLinks = [];
                        window.open = (url) => { window.openedLinks.push(url); return null; };
                        useShellStore.getState().setLastSettingsTab('feedback');
                        const h = React.createElement;
                        const root = createRoot(document.getElementById('root'));
                        window.showDatabaseFailure = () => {
                            useRuntimeStore.getState().setDatabaseUpgradeState({phase: 'error', failureLogPath: 'synthetic-error-log.txt'});
                            root.render(h(I18nextProvider, {i18n}, h(DatabaseUpgradeDialog, {open: true})));
                        };
                        root.render(
                            h(I18nextProvider, {i18n}, h(QueryClientProvider, {client: new QueryClient()},
                                h(BrowserRouter, null, h(AppMenuBar), h(SettingsPage),
                                    h(LoginPageFooter, {onOpenGithub: () => {}, onOpenDiscord: () => {}})))));
                        </script></body></html>`
                                );
                                response.setHeader('Content-Type', 'text/html');
                                response.end(html);
                            } catch (error) {
                                next(error);
                            }
                        }
                    );
                    server.middlewares.use(
                        '/licenses',
                        async (request, response, next) => {
                            if (request.url !== '/third-party-licenses.json')
                                return next();
                            response.setHeader(
                                'Content-Type',
                                'application/json'
                            );
                            response.end(
                                await readFile(
                                    path.join(
                                        repo,
                                        'dist/licenses/third-party-licenses.json'
                                    )
                                )
                            );
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
    const context = await browser.newContext({
        locale: 'en-US',
        viewport: { width: 1280, height: 900 }
    });
    const login = await context.request.post(`${origin}/api/login`, {
        headers: { Origin: origin, 'X-VRCX-Web': '1' },
        data: { password }
    });
    assert.equal(login.status(), 200);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${origin}/__about_test?tab=feedback`);
    await page.getByRole('tab', { name: 'System', exact: true }).waitFor();
    assert.equal(
        await page
            .getByRole('tab', { name: 'System', exact: true })
            .getAttribute('aria-selected'),
        'true'
    );
    for (const locale of ['en', 'zh-CN', 'zh-TW']) {
        const messages = JSON.parse(
            await readFile(
                path.join(repo, `src/localization/${locale}.json`),
                'utf8'
            )
        );
        await page.evaluate((locale) => window.setLanguage(locale), locale);
        const t = messages.app_menu;
        assert.equal(
            await page
                .getByRole('button', { name: 'Discord', exact: true })
                .count(),
            0
        );
        assert.equal(
            await page
                .getByRole('button', { name: 'GitHub', exact: true })
                .count(),
            0
        );
        assert.equal(
            await page
                .getByRole('tab', {
                    name: messages.view.settings.category.feedback,
                    exact: true
                })
                .count(),
            0
        );
        await page.getByRole('menuitem', { name: t.help, exact: true }).click();
        for (const label of [
            t.send_feedback,
            t.report_issue,
            'Discord',
            'GitHub',
            messages.nav_menu.qq_group
        ]) {
            assert.equal(
                await page
                    .getByRole('menuitem', { name: label, exact: true })
                    .count(),
                0
            );
        }
        assert.equal(
            await page.getByText(t.community, { exact: true }).count(),
            0
        );
        await page.getByRole('menuitem', { name: t.about }).click();
        const dialog = page.getByRole('dialog');
        await dialog
            .getByRole('heading', { name: 'VRCX-docker', exact: true })
            .waitFor();
        await dialog
            .getByText(messages.view.about.web.description, { exact: true })
            .waitFor();
        await dialog
            .getByText(messages.view.about.web.attribution, { exact: true })
            .waitFor();
        assert.equal(
            await dialog.getByText('Ko-fi', { exact: true }).count(),
            0
        );
        for (const [name, url] of [
            [
                messages.view.about.web.repository,
                'https://github.com/E-larex/VRCX-docker'
            ],
            [
                messages.view.about.web.upstream,
                'https://github.com/Map1en/VRCX-0'
            ],
            [
                messages.view.about.license_line,
                'https://github.com/E-larex/VRCX-docker/blob/master/LICENSE'
            ]
        ]) {
            await dialog.getByRole('button', { name, exact: true }).click();
            await page.waitForFunction(
                (url) => window.openedLinks.at(-1) === url,
                url
            );
        }
        await dialog
            .getByRole('button', { name: t.open_source_licenses, exact: true })
            .click();
        await page
            .getByRole('heading', {
                name: messages.dialog.open_source.header,
                exact: true
            })
            .waitFor();
        await page
            .getByRole('button', { name: /react 19/ })
            .first()
            .waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    await page.evaluate(() => window.setLanguage('en'));
    await page.evaluate(() => window.showDatabaseFailure());
    const english = JSON.parse(
        await readFile(path.join(repo, 'src/localization/en.json'), 'utf8')
    );
    await page
        .getByRole('button', {
            name: english.message.database.open_failure_log_folder,
            exact: true
        })
        .waitFor();
    assert.equal(
        await page
            .getByRole('button', {
                name: english.message.database.create_github_issue,
                exact: true
            })
            .count(),
        0
    );
    await page
        .getByRole('button', {
            name: english.message.database.restart_app,
            exact: true
        })
        .waitFor();
    assert.deepEqual(pageErrors, []);
    console.log(
        'PASS: Web feedback/community entries absent from menu, settings, login footer and database error dialog, stale feedback tab falls back, localized About attribution and repository/license links, third-party licenses. Synthetic website credentials; no VRChat login.'
    );
} finally {
    await browser?.close();
    await vite?.close();
    await stopBackend();
    await rm(temporary, { recursive: true, force: true });
}
