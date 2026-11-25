import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
    isSettingsCardAvailable,
    isSettingsTabAvailable,
    isWebHost
} from '@/platform/host';
import i18n from '@/services/i18nService';
import { isUpdateCheckDisabledBuild } from '@/shared/buildLabel';
import type { SettingsManifestEntry } from '@/shared/constants/settingsManifest';
import {
    buildSettingsSearchIndex,
    searchSettingsIndex
} from '@/shared/utils/settingsSearch';
import { useRuntimeStore } from '@/state/runtimeStore';

export function useSettingsSearch(
    query: string,
    limit?: number
): SettingsManifestEntry[] {
    const { t } = useTranslation();
    const platform = useRuntimeStore(
        (state) => state.hostCapabilities.platform
    );
    const gameLogIngest = useRuntimeStore(
        (state) => state.hostCapabilities.runtimeGameLogIngest.supported
    );
    const index = useMemo(
        () =>
            buildSettingsSearchIndex([(key) => t(key), i18n.getFixedT('en')], {
                platform,
                gameLogIngest,
                updateCheckDisabledBuild: isUpdateCheckDisabledBuild()
            }).filter(
                ({ entry }) =>
                    isSettingsTabAvailable(entry.tab) &&
                    isSettingsCardAvailable(entry.cardId) &&
                    !(
                        isWebHost &&
                        (entry.id === 'interface.appearance.zoom' ||
                            entry.id === 'interface.appearance.ctrl-wheel-zoom')
                    )
            ),
        [gameLogIngest, platform, t]
    );
    return useMemo(
        () => searchSettingsIndex(index, query, limit),
        [index, query, limit]
    );
}
