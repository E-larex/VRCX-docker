import fs from 'node:fs';
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import browserslist from 'browserslist';
import { browserslistToTargets } from 'lightningcss';
import { defineConfig, type Plugin } from 'vite';

const webview2BuildTarget = {
    vite: 'edge146',
    browserslist: 'Edge 146'
};
const webkitLegacyBuildTarget = {
    vite: 'safari17.4',
    browserslist: 'Safari 17.4'
};
const webkitModernBuildTarget = {
    vite: 'safari18.2',
    browserslist: 'Safari 18.2'
};

function getPlatformBuildTarget() {
    const webkitBuildTargetOverride =
        process.env['VRCX_0_WEBKIT_BUILD_TARGET']?.trim();

    if (webkitBuildTargetOverride === 'safari17.4') {
        return webkitLegacyBuildTarget;
    }
    if (webkitBuildTargetOverride === 'safari18.2') {
        return webkitModernBuildTarget;
    }
    if (webkitBuildTargetOverride) {
        throw new Error(
            `Unsupported VRCX_0_WEBKIT_BUILD_TARGET: ${webkitBuildTargetOverride}`
        );
    }

    switch (process.platform) {
        case 'darwin':
            return webkitModernBuildTarget;
        case 'linux':
            return webkitLegacyBuildTarget;
        case 'win32':
        default:
            return webview2BuildTarget;
    }
}

function createReactDevtoolsStandalonePlugin(enabled: boolean): Plugin {
    return {
        name: 'vrcx-0-react-devtools-standalone',
        transformIndexHtml() {
            if (!enabled) return;

            return [
                {
                    tag: 'script',
                    attrs: {
                        src: 'http://localhost:8097'
                    },
                    injectTo: 'body-prepend'
                }
            ];
        }
    };
}

export default defineConfig(({ mode }) => {
    const webHost = mode === 'web';
    const tauriConf = JSON.parse(
        fs.readFileSync(
            new URL('./src-tauri/tauri.conf.json', import.meta.url),
            'utf-8'
        )
    );
    const version = tauriConf.version;
    const buildTarget = getPlatformBuildTarget();
    const enableReactDevtoolsStandalone =
        mode === 'development' && process.env.VITE_REACT_DEVTOOLS === '1';
    const macosSystemFontsEnabled = process.platform === 'darwin';

    return {
        base: '',
        plugins: [
            ...(webHost
                ? [
                      {
                          name: 'vrcx-web-entry',
                          transformIndexHtml: {
                              order: 'pre' as const,
                              handler: (html: string) => ({
                                  html: html.replace(
                                      '/src/main.js',
                                      '/src/web-main.tsx'
                                  ),
                                  tags: [
                                      {
                                          tag: 'link',
                                          attrs: {
                                              rel: 'icon',
                                              type: 'image/x-icon',
                                              href: '/src-tauri/icons/icon.ico'
                                          },
                                          injectTo: 'head' as const
                                      }
                                  ]
                              })
                          }
                      }
                  ]
                : []),
            createReactDevtoolsStandalonePlugin(enableReactDevtoolsStandalone),
            react(),
            tailwindcss()
        ],
        resolve: {
            alias: {
                ...(webHost
                    ? {
                          '@tauri-apps/api/core': resolve(
                              import.meta.dirname,
                              'src/platform/web/core.ts'
                          ),
                          '@tauri-apps/api/event': resolve(
                              import.meta.dirname,
                              'src/platform/web/events.ts'
                          ),
                          '@tauri-apps/api/window': resolve(
                              import.meta.dirname,
                              'src/platform/web/window.ts'
                          ),
                          '@tauri-apps/api/webviewWindow': resolve(
                              import.meta.dirname,
                              'src/platform/web/window.ts'
                          ),
                          '@tauri-apps/plugin-fs': resolve(
                              import.meta.dirname,
                              'src/platform/web/cache.ts'
                          )
                      }
                    : {}),
                '@': resolve(import.meta.dirname, 'src')
            }
        },
        css: {
            transformer: 'lightningcss',
            lightningcss: {
                targets: browserslistToTargets(
                    browserslist(buildTarget.browserslist)
                )
            }
        },
        define: {
            VERSION: JSON.stringify(version),
            VRCX_0_BUILD_LABEL: JSON.stringify(
                process.env['VRCX_0_BUILD_LABEL'] || ''
            ),
            VRCX_0_BUILD_BADGE: JSON.stringify(
                process.env['VRCX_0_BUILD_BADGE'] || ''
            ),
            VRCX_0_DISABLE_UPDATE_CHECK: JSON.stringify(
                webHost || process.env['VRCX_0_DISABLE_UPDATE_CHECK'] === '1'
            ),
            VRCX_0_MACOS_SYSTEM_FONTS_ENABLED: JSON.stringify(
                macosSystemFontsEnabled
            )
        },
        server: {
            port: 9000,
            strictPort: true,
            ...(webHost
                ? {
                      proxy: {
                          '/api': 'http://127.0.0.1:8080',
                          '/health': 'http://127.0.0.1:8080'
                      }
                  }
                : {}),
            watch: {
                ignored: [
                    '**/.github/**',
                    '**/.husky/**',
                    '**/.vscode/**',
                    '**/coverage/**',
                    '**/crates/**',
                    '**/docs/**',
                    '**/images/**',
                    '**/scripts/**',
                    '**/signatures/**',
                    '**/src-tauri/**',
                    '**/target/**'
                ]
            }
        },
        build: {
            target: buildTarget.vite,
            license: {
                fileName: 'licenses/frontend-licenses.json'
            },
            copyPublicDir: false,
            reportCompressedSize: false,
            chunkSizeWarningLimit: 700,
            assetsInlineLimit: 0
        }
    };
});
