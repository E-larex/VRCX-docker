export async function request<T>(path: string, body?: unknown): Promise<T> {
    const multipart = body instanceof FormData;
    const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers:
            body === undefined
                ? {}
                : {
                      'X-VRCX-Web': '1',
                      ...(multipart
                          ? {}
                          : { 'Content-Type': 'application/json' })
                  },
        body:
            body === undefined
                ? undefined
                : multipart
                  ? body
                  : JSON.stringify(body)
    });
    if (response.status === 401 && path !== '/api/login') {
        window.location.reload();
    }
    const result: unknown = await response.json();
    if (!response.ok) throw result;
    return result as T;
}

export async function logoutWebsite(): Promise<void> {
    await request('/api/logout', {});
    window.location.reload();
}
