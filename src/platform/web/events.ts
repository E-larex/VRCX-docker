import { request } from './http';

export type Event<T> = { event: string; id: number; payload: T };
export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;
const listeners = new Map<string, Set<EventCallback<unknown>>>();
let connection: EventSource | undefined;
let connected = false;
let ready: Promise<void> | undefined;

function connect(): Promise<void> {
    if (ready) return ready;
    ready = new Promise((resolve) => {
        connection = new EventSource('/api/events');
        connection.onopen = () => {
            // A fresh snapshot is needed after any missed events during a disconnect.
            if (connected) window.location.reload();
            connected = true;
            resolve();
        };
        connection.onmessage = ({ data }) => {
            const message = JSON.parse(data) as {
                event: string;
                payload: unknown;
            };
            dispatch(message.event, message.payload);
        };
        connection.addEventListener('resync', () => window.location.reload());
        connection.onerror = () => {
            void request<{ authenticated: boolean }>('/api/session')
                .then((session) => {
                    if (!session.authenticated) window.location.reload();
                })
                .catch(() => {});
        };
    });
    return ready;
}
function dispatch(name: string, payload: unknown) {
    for (const handler of listeners.get(name) ?? []) {
        try {
            handler({ event: name, id: 0, payload });
        } catch (error) {
            console.error('Web event handler failed', error);
        }
    }
}
export async function listen<T>(
    name: string,
    handler: EventCallback<T>
): Promise<UnlistenFn> {
    let bucket = listeners.get(name);
    if (!bucket) {
        bucket = new Set();
        listeners.set(name, bucket);
    }
    const callback = handler as EventCallback<unknown>;
    bucket.add(callback);
    await connect();
    return () => {
        bucket.delete(callback);
    };
}
export async function once<T>(
    name: string,
    handler: EventCallback<T>
): Promise<UnlistenFn> {
    let off: UnlistenFn = () => {};
    off = await listen<T>(name, (event) => {
        off();
        handler(event);
    });
    return off;
}
export async function emit<T>(name: string, payload?: T): Promise<void> {
    dispatch(name, payload);
}
export const emitTo = async <T>(_target: unknown, name: string, payload?: T) =>
    emit(name, payload);
