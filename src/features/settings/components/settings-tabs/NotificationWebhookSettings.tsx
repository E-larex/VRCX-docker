import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import {
    commands,
    type NotificationWebhookFormat,
    type WebhookDeliverySnapshot
} from '@/platform/tauri/bindings';
import { setStringConfigPreference } from '@/services/preferencesService';
import { toast } from '@/services/toastService';
import { usePreferencesStore } from '@/state/preferencesStore';

import { useSettingsPageSection } from '../../SettingsPageStateContext';
import { WebhookSettingsGroup } from './WebhookSettingsGroup';

export function NotificationWebhookSettings() {
    const { t } = useTranslation();
    const {
        setWebhookNotificationsDialogOpen,
        saveStringPreference,
        saveBoolPreference
    } = useSettingsPageSection('notifications');
    const prefs = usePreferencesStore(
        useShallow((state) => ({
            webhookEnabled: state.webhookEnabled,
            webhookAuthEventsEnabled: state.webhookAuthEventsEnabled,
            webhookUrl: state.webhookUrl,
            webhookFormat: state.webhookFormat,
            webhookTemplate: state.webhookTemplate,
            webhookFields: state.webhookFields
        }))
    );
    const [webhookDeliverySnapshot, setWebhookDeliverySnapshot] =
        useState<WebhookDeliverySnapshot | null>(null);
    const [webhookDeliveryLoading, setWebhookDeliveryLoading] = useState(true);

    const refreshWebhookDeliveryStatus = useCallback(
        async (showError: boolean) => {
            setWebhookDeliveryLoading(true);
            try {
                setWebhookDeliverySnapshot(
                    await commands.appWebhookDeliverySnapshotGet()
                );
            } catch (error: unknown) {
                if (showError) {
                    toast.add({
                        type: 'error',
                        title:
                            error instanceof Error
                                ? error.message
                                : String(error)
                    });
                }
            } finally {
                setWebhookDeliveryLoading(false);
            }
        },
        []
    );

    useEffect(() => {
        void refreshWebhookDeliveryStatus(false);
    }, [refreshWebhookDeliveryStatus]);

    function saveWebhookEnabled(checked: boolean) {
        saveBoolPreference('webhookEnabled', 'webhookEnabled', checked);
    }

    function saveWebhookAuthEventsEnabled(checked: boolean) {
        saveBoolPreference(
            'webhookAuthEventsEnabled',
            'webhookAuthEventsEnabled',
            checked
        );
    }

    function saveWebhookUrl(value: string) {
        saveStringPreference('webhookUrl', 'webhookUrl', value);
    }

    function saveWebhookFormat(value: NotificationWebhookFormat) {
        saveStringPreference('webhookFormat', 'webhookFormat', value);
    }

    function saveWebhookFields(value: string) {
        saveStringPreference('webhookFields', 'webhookFields', value);
    }

    async function saveWebhookTemplate(value: string) {
        await setStringConfigPreference('webhookTemplate', value);
    }

    function openWebhookNotificationFilters() {
        setWebhookNotificationsDialogOpen(true);
    }

    async function sendTestWebhook() {
        try {
            const outcome = await commands.appWebhookSendTest(
                String(prefs.webhookUrl || ''),
                prefs.webhookFormat,
                String(prefs.webhookFields || ''),
                prefs.webhookTemplate,
                'notification'
            );
            toast.add({
                type: 'success',
                title: t(
                    'view.settings.notifications.notifications.webhook.test_sent',
                    { status: outcome.status }
                )
            });
        } catch (error: unknown) {
            toast.add({
                type: 'error',
                title: error instanceof Error ? error.message : String(error)
            });
        }
    }

    return (
        <WebhookSettingsGroup
            prefs={prefs}
            onWebhookEnabledChange={saveWebhookEnabled}
            onWebhookAuthEventsEnabledChange={saveWebhookAuthEventsEnabled}
            onWebhookUrlCommit={saveWebhookUrl}
            onWebhookFormatChange={saveWebhookFormat}
            onWebhookFieldsChange={saveWebhookFields}
            onWebhookTemplateSave={saveWebhookTemplate}
            onOpenWebhookNotificationFiltersDialog={
                openWebhookNotificationFilters
            }
            onTestWebhook={sendTestWebhook}
            deliverySnapshot={webhookDeliverySnapshot}
            deliveryStatusLoading={webhookDeliveryLoading}
            onRefreshDeliveryStatus={() => {
                void refreshWebhookDeliveryStatus(true);
            }}
        />
    );
}
