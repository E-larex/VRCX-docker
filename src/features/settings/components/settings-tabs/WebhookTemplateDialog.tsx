import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, type WebhookSample } from '@/platform/tauri/bindings';
import { WEBHOOK_TEMPLATE_VARIABLES } from '@/shared/constants/webhook';
import { Button } from '@/ui/shadcn/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger
} from '@/ui/shadcn/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/ui/shadcn/select';
import { Textarea } from '@/ui/shadcn/textarea';

const key = 'view.settings.notifications.notifications.webhook.';

export function WebhookTemplateDialog({
    template,
    disabled,
    onSave
}: {
    template: string;
    disabled: boolean;
    onSave(value: string): Promise<void>;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(template);
    const [sample, setSample] = useState<WebhookSample>('notification');
    const [preview, setPreview] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    async function run(action: 'preview' | 'save') {
        setBusy(true);
        setError('');
        try {
            const payload = await commands.appWebhookTemplatePreview(
                draft,
                sample
            );
            setPreview(JSON.stringify(payload, null, 2));
            if (action === 'save') {
                await onSave(draft);
                setOpen(false);
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (busy) return;
                setOpen(next);
                if (next) {
                    setDraft(template);
                    setPreview('');
                    setError('');
                }
            }}
        >
            <DialogTrigger
                render={
                    <Button
                        type="button"
                        variant="outline"
                        disabled={disabled}
                    />
                }
            >
                {t(`${key}template_edit`)}
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t(`${key}template_edit`)}</DialogTitle>
                    <DialogDescription>
                        {t(`${key}template_help`, {
                            expression: '{{ message | tojson }}'
                        })}
                    </DialogDescription>
                </DialogHeader>
                <p className="text-muted-foreground text-sm">
                    {t(`${key}template_variables`)}:{' '}
                    {WEBHOOK_TEMPLATE_VARIABLES.join(', ')}
                </p>
                <label htmlFor="webhook-template-editor">
                    {t(`${key}template_json`)}
                </label>
                <Textarea
                    id="webhook-template-editor"
                    className="min-h-48 font-mono"
                    value={draft}
                    disabled={busy}
                    aria-invalid={Boolean(error)}
                    spellCheck={false}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        setPreview('');
                        setError('');
                    }}
                />
                <label htmlFor="webhook-template-sample">
                    {t(`${key}template_sample`)}
                </label>
                <Select
                    value={sample}
                    disabled={busy}
                    items={[
                        {
                            value: 'notification',
                            label: t(`${key}template_notification`)
                        },
                        { value: 'auth', label: t(`${key}template_auth`) }
                    ]}
                    onValueChange={(value) => {
                        if (value) {
                            setSample(value);
                            setPreview('');
                            setError('');
                        }
                    }}
                >
                    <SelectTrigger id="webhook-template-sample">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="notification">
                            {t(`${key}template_notification`)}
                        </SelectItem>
                        <SelectItem value="auth">
                            {t(`${key}template_auth`)}
                        </SelectItem>
                    </SelectContent>
                </Select>
                {error && (
                    <p role="alert" className="text-destructive text-sm">
                        {error}
                    </p>
                )}
                {preview && (
                    <pre
                        aria-label={t(`${key}template_preview`)}
                        className="bg-muted overflow-auto rounded-md p-3 text-xs"
                    >
                        {preview}
                    </pre>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void run('preview')}
                    >
                        {t(`${key}template_preview`)}
                    </Button>
                    <Button
                        type="button"
                        disabled={busy}
                        onClick={() => void run('save')}
                    >
                        {t('common.actions.save')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
