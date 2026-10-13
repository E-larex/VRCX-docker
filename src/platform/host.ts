/** Build-time host selection keeps the desktop bundle unchanged. */
export const isWebHost = import.meta.env.MODE === 'web';

const desktopSettings = new Set([
    'system.startup',
    'system.window',
    'system.vrchat',
    'system.updates',
    'integrations.discord',
    'notifications.desktop',
    'notifications.desktop_widget',
    'notifications.tts'
]);
export function isSettingsCardAvailable(cardId: string): boolean {
    return !isWebHost || !desktopSettings.has(cardId);
}
