import { listen } from './events';
export class PhysicalPosition {
    constructor(
        public x: number,
        public y: number
    ) {}
}
export class PhysicalSize {
    constructor(
        public width: number,
        public height: number
    ) {}
}
export const LogicalPosition = PhysicalPosition;
export const LogicalSize = PhysicalSize;
export const UserAttentionType = { Informational: 2 };
const browserWindow = {
    label: 'main',
    listen,
    onFocusChanged: async (callback: (event: { payload: boolean }) => void) => {
        const focus = () => callback({ payload: true });
        const blur = () => callback({ payload: false });
        window.addEventListener('focus', focus);
        window.addEventListener('blur', blur);
        return () => {
            window.removeEventListener('focus', focus);
            window.removeEventListener('blur', blur);
        };
    },
    onResized: async (callback: () => void) => {
        window.addEventListener('resize', callback);
        return () => window.removeEventListener('resize', callback);
    },
    isFocused: async () => document.hasFocus(),
    isMaximized: async () => false,
    scaleFactor: async () => window.devicePixelRatio,
    setZoom: async (_zoom: number) => {
        // Desktop zoom preferences must never scale the browser document.
        document.documentElement.style.removeProperty('zoom');
    },
    setTheme: async () => {},
    setFocus: async () => window.focus(),
    innerSize: async () =>
        new PhysicalSize(window.innerWidth, window.innerHeight),
    outerSize: async () =>
        new PhysicalSize(window.innerWidth, window.innerHeight),
    outerPosition: async () => new PhysicalPosition(0, 0)
};
export const getCurrentWindow = () => browserWindow;
export const getCurrentWebviewWindow = getCurrentWindow;
export const currentMonitor = async () => null;
export const availableMonitors = async () => [];
