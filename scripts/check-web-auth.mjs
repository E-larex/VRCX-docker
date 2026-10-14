// Run after building the Web frontend and debug server. Requires Playwright and Chromium.
// External installations: VRCX_TEST_PLAYWRIGHT_MODULE and VRCX_TEST_CHROMIUM.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
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
const temporary = await mkdtemp(path.join(tmpdir(), 'vrcx-auth-browser-'));
const data = path.join(temporary, 'data');
const password = 'synthetic-browser-auth-password';
const passwordHash = (
    await readFile(
        path.join(repo, 'crates/web-server/tests/fixtures/password.argon2'),
        'utf8'
    )
).trim();
let backend;
let browser;
let vite;
async function freePort() {
    const listener = net.createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    return port;
}
const backendPort = await freePort();
const frontendPort = await freePort();
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const origin = `http://127.0.0.1:${frontendPort}`;
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
async function startBackend(settings, expectFailure = false) {
    await stopBackend();
    backend = spawn(
        path.join(repo, 'target/debug/vrcx-0-web'),
        ['--data-dir', data],
        {
            cwd: repo,
            stdio: 'ignore',
            env: {
                ...Object.fromEntries(
                    Object.entries(process.env).filter(
                        ([key]) => !key.startsWith('VRCX_')
                    )
                ),
                VRCX_WEB_BIND: `127.0.0.1:${backendPort}`,
                VRCX_WEB_ORIGIN: origin,
                VRCX_WEB_DIST: path.join(repo, 'dist'),
                ...settings
            }
        }
    );
    for (let attempt = 0; attempt < 150; attempt++) {
        if (backend.exitCode !== null) {
            assert(expectFailure, 'Backend unexpectedly exited');
            assert.notEqual(backend.exitCode, 0);
            return;
        }
        if (
            await fetch(`${backendOrigin}/health`)
                .then((r) => r.ok)
                .catch(() => false)
        ) {
            assert(
                !expectFailure,
                'Invalid authentication configuration unexpectedly started'
            );
            return;
        }
        await delay(100);
    }
    throw new Error('Backend startup timed out');
}
try {
    await mkdir(data);
    vite = await createServer({
        root: repo,
        mode: 'web',
        logLevel: 'error',
        server: {
            host: '127.0.0.1',
            port: frontendPort,
            strictPort: true,
            proxy: {
                '/api': { target: backendOrigin, changeOrigin: false },
                '/health': backendOrigin
            }
        }
    });
    await vite.listen();
    browser = await chromium.launch({
        executablePath: process.env.VRCX_TEST_CHROMIUM,
        headless: true,
        args: ['--no-sandbox']
    });
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    const session = async () =>
        (await context.request.get(`${origin}/api/session`)).json();
    const appReady = async () => {
        await page.locator('[data-app-titlebar]').waitFor();
        assert.equal(
            await page.getByText('Website password', { exact: true }).count(),
            0
        );
        assert.equal(
            await page
                .getByRole('button', {
                    name: 'Sign out of website',
                    exact: true
                })
                .count(),
            0
        );
    };
    const quitMenu = async () => {
        await page
            .getByRole('menuitem', { name: 'VRCX-0', exact: true })
            .click();
        return page.getByRole('menuitem', {
            name: /app_menu.quit|Quit VRCX-0/
        });
    };
    for (const value of [undefined, '']) {
        await startBackend({
            VRCX_WEB_LAN_MODE: '1',
            ...(value === undefined ? {} : { VRCX_WEB_PASSWORD: value })
        });
        await context.clearCookies();
        assert.deepEqual(await session(), {
            authenticated: true,
            passwordRequired: false
        });
        const events = page.waitForResponse(
            (r) => r.url().endsWith('/api/events') && r.status() === 200
        );
        await page.goto(origin);
        await appReady();
        await events;
        assert.equal(
            (await context.cookies()).some(
                (c) => c.name === 'vrcx_web_session'
            ),
            false
        );
        const reply = await page.evaluate(async () => {
            const response = await fetch('/api/invoke/storage__get_all', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-VRCX-Web': '1'
                },
                body: '{}'
            });
            return response.status;
        });
        assert.equal(reply, 200);
        assert.equal(
            await page
                .getByRole('menuitem', { name: 'VRCX-0', exact: true })
                .count(),
            0
        );
        await page.goto('about:blank');
    }
    for (const [lan, configuredPassword] of ['1', '0'].flatMap((lan) =>
        [password, passwordHash].map((value) => [lan, value])
    )) {
        await startBackend({
            VRCX_WEB_LAN_MODE: lan,
            VRCX_WEB_PASSWORD: configuredPassword
        });
        await context.clearCookies();
        assert.deepEqual(await session(), {
            authenticated: false,
            passwordRequired: true
        });
        await page.goto(origin);
        assert.equal(
            (
                await context.request.post(`${origin}/api/login`, {
                    headers: {
                        Origin: 'http://attacker.example',
                        'X-VRCX-Web': '1'
                    },
                    data: { password }
                })
            ).status(),
            403
        );
        for (const invalid of [
            'incorrect-password',
            ...(configuredPassword === passwordHash ? [passwordHash] : [])
        ]) {
            const reply = await context.request.post(`${origin}/api/login`, {
                headers: { Origin: origin, 'X-VRCX-Web': '1' },
                data: { password: invalid }
            });
            assert.equal(reply.status(), 401);
            await delay(1100);
        }
        await page.getByLabel('Website password').fill(password);
        const events = page.waitForResponse(
            (r) => r.url().endsWith('/api/events') && r.status() === 200
        );
        await page
            .getByRole('button', { name: 'Sign in', exact: true })
            .click();
        await appReady();
        await events;
        assert.equal((await session()).authenticated, true);
        const quit = await quitMenu();
        await Promise.all([page.waitForEvent('load'), quit.click()]);
        await page.waitForFunction(
            async () =>
                !(await fetch('/api/session').then((r) => r.json()))
                    .authenticated
        );
        assert.equal((await session()).authenticated, false);
        await page.goto(origin);
        await page.getByLabel('Website password').waitFor();
        await page.goto('about:blank');
    }
    for (const settings of [
        { VRCX_WEB_LAN_MODE: '0' },
        { VRCX_WEB_LAN_MODE: '0', VRCX_WEB_PASSWORD: '' },
        { VRCX_WEB_LAN_MODE: '1', VRCX_WEB_PASSWORD: 'short' },
        {
            VRCX_WEB_LAN_MODE: '1',
            VRCX_WEB_PASSWORD_FILE: path.join(temporary, 'missing-password')
        }
    ])
        await startBackend(settings, true);
    for (const value of ['', 'unused-password-file']) {
        await startBackend(
            {
                VRCX_WEB_LAN_MODE: '1',
                VRCX_WEB_PASSWORD: password,
                VRCX_WEB_PASSWORD_FILE: value
            },
            true
        );
    }
    for (const value of [
        '$argon2id$broken',
        passwordHash.replace('argon2id', 'argon2i')
    ]) {
        await startBackend(
            { VRCX_WEB_LAN_MODE: '1', VRCX_WEB_PASSWORD: value },
            true
        );
    }
    console.log(
        'PASS: LAN empty/unset password, authenticated LAN/fixed-origin login and menu logout, cookie-free SSE, plaintext/Argon2id verification, origin rejection and removed password-file configuration rejection.'
    );
} finally {
    await browser?.close();
    await vite?.close();
    await stopBackend();
    await rm(temporary, { recursive: true, force: true });
}
