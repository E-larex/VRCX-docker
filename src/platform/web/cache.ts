// These two upstream consumers use the filesystem only as a disposable UI cache.
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
