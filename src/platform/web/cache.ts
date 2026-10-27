import { convertFileSrc } from './core';

export async function readFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const response = await fetch(convertFileSrc(path));
    if (!response.ok) throw new Error('File unavailable');
    return new Uint8Array(await response.arrayBuffer());
}

export async function stat(path: string) {
    const response = await fetch(convertFileSrc(path), { method: 'HEAD' });
    if (!response.ok) throw new Error('File unavailable');
    const size = Number(response.headers.get('content-length'));
    if (!response.headers.has('content-length') || !Number.isFinite(size))
        throw new Error('File size unavailable');
    return { isFile: true, size };
}

// Text operations provide a disposable browser UI cache.
export const BaseDirectory = { AppCache: 'AppCache' };
export async function mkdir(_path: string, _options?: unknown): Promise<void> {}
export async function readTextFile(
    path: string,
    _options?: unknown
): Promise<string> {
    const value = localStorage.getItem(`vrcx-web-cache:${path}`);
    if (value === null) throw new Error('Cache miss');
    return value;
}
export async function writeTextFile(
    path: string,
    value: string,
    _options?: unknown
): Promise<void> {
    localStorage.setItem(`vrcx-web-cache:${path}`, value);
}
