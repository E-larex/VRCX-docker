import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '@/styles/globals.css';
import { request } from './platform/web/http';

function Login() {
    const [dark, setDark] = useState(
        () => window.matchMedia('(prefers-color-scheme: dark)').matches
    );
    useEffect(() => {
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const syncTheme = () => setDark(media.matches);
        syncTheme();
        media.addEventListener('change', syncTheme);
        return () => media.removeEventListener('change', syncTheme);
    }, []);
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const chinese = navigator.language.startsWith('zh');
    return (
        <main
            className={`${dark ? 'dark ' : ''}bg-background text-foreground flex min-h-screen items-center justify-center p-6`}
            style={{ colorScheme: dark ? 'dark' : 'light' }}
        >
            <form
                className="border-border bg-card text-card-foreground w-full max-w-sm space-y-5 rounded-xl border p-8"
                onSubmit={async (event) => {
                    event.preventDefault();
                    setPending(true);
                    setError('');
                    try {
                        await request('/api/login', { password });
                        window.location.reload();
                    } catch (cause) {
                        setError(
                            cause &&
                                typeof cause === 'object' &&
                                'message' in cause
                                ? String(cause.message)
                                : String(cause)
                        );
                        setPending(false);
                    }
                }}
            >
                <h1 className="text-2xl font-semibold">VRCX-0 Web</h1>
                <p className="text-muted-foreground text-sm">
                    {chinese
                        ? '输入网站密码。登录后可管理 VRChat 账号。'
                        : 'Enter your website password to manage your VRChat account.'}
                </p>
                <label className="block space-y-2">
                    <span>{chinese ? '网站密码' : 'Website password'}</span>
                    <input
                        className="border-input w-full rounded-md border p-2"
                        type="password"
                        autoComplete="current-password"
                        required
                        autoFocus
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                    />
                </label>
                {error && (
                    <p role="alert" className="text-destructive text-sm">
                        {error}
                    </p>
                )}
                <button
                    type="submit"
                    className="bg-primary text-primary-foreground w-full rounded-md p-2"
                    disabled={pending}
                >
                    {pending ? '…' : chinese ? '登录' : 'Sign in'}
                </button>
            </form>
        </main>
    );
}

async function start() {
    // randomUUID requires HTTPS in browsers; getRandomValues also works on LAN HTTP.
    // Install before loading the unchanged upstream features that use request IDs.
    if (typeof crypto.randomUUID !== 'function') {
        crypto.randomUUID = () => {
            const bytes = crypto.getRandomValues(new Uint8Array(16));
            bytes[6] = (bytes[6]! & 0x0f) | 0x40;
            bytes[8] = (bytes[8]! & 0x3f) | 0x80;
            const hex = Array.from(bytes, (byte) =>
                byte.toString(16).padStart(2, '0')
            ).join('');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        };
    }
    document.documentElement.dataset.host = 'web';
    const session = await request<{ authenticated: boolean }>('/api/session');
    if (session.authenticated) await import('./main');
    else createRoot(document.getElementById('root')!).render(<Login />);
}
void start().catch((error) => {
    const root = document.getElementById('root');
    if (root)
        root.textContent = `Unable to connect to VRCX-0: ${String(error)}`;
});
