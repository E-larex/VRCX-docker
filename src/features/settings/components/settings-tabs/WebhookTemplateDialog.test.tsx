// @vitest-environment jsdom
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preview = vi.hoisted(() => vi.fn());
vi.mock('@/platform/tauri/bindings', () => ({
    commands: { appWebhookTemplatePreview: preview }
}));

import { WebhookTemplateDialog } from './WebhookTemplateDialog';

const key = 'view.settings.notifications.notifications.webhook.';
const template = '{"body":{{ message | tojson }}}';

describe('WebhookTemplateDialog', () => {
    beforeEach(() => {
        preview.mockReset().mockResolvedValue({ body: 'Sample' });
    });
    afterEach(cleanup);

    async function open(onSave = vi.fn().mockResolvedValue(undefined)) {
        render(
            <WebhookTemplateDialog
                template={template}
                disabled={false}
                onSave={onSave}
            />
        );
        fireEvent.click(
            screen.getByRole('button', { name: `${key}template_edit` })
        );
        await screen.findByRole('textbox', { name: `${key}template_json` });
        return { onSave };
    }

    it('keeps drafts local and previews without saving or sending', async () => {
        const { onSave } = await open();
        const draft = '{"text":{{ title | tojson }}}';
        fireEvent.change(screen.getByRole('textbox'), {
            target: { value: draft }
        });
        fireEvent.click(
            screen.getByRole('button', { name: `${key}template_preview` })
        );
        await waitFor(() =>
            expect(preview).toHaveBeenCalledWith(draft, 'notification')
        );
        await screen.findByText(/"body": "Sample"/);
        expect(onSave).not.toHaveBeenCalled();
        expect(
            screen.queryByRole('button', { name: `${key}send_test` })
        ).toBeNull();
        fireEvent.click(
            screen.getByRole('button', { name: 'common.actions.save' })
        );
        await waitFor(() => expect(onSave).toHaveBeenCalledWith(draft));
    });

    it('shows validation errors and does not save an invalid draft', async () => {
        const { onSave } = await open();
        preview.mockRejectedValue(
            'Invalid webhook template: undefined value at line 1.'
        );
        fireEvent.click(
            screen.getByRole('button', { name: 'common.actions.save' })
        );
        expect((await screen.findByRole('alert')).textContent).toContain(
            'undefined value'
        );
        expect(onSave).not.toHaveBeenCalled();
        fireEvent.click(
            screen.getByRole('button', { name: `${key}template_preview` })
        );
        await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
        expect(
            screen.queryByRole('button', { name: `${key}send_test` })
        ).toBeNull();
    });

    it('previews the current draft with the selected authentication sample', async () => {
        const { onSave } = await open();
        const user = userEvent.setup();
        await user.click(screen.getByRole('combobox'));
        await user.click(
            await screen.findByRole('option', { name: `${key}template_auth` })
        );
        fireEvent.click(
            screen.getByRole('button', { name: `${key}template_preview` })
        );
        await waitFor(() =>
            expect(preview).toHaveBeenCalledWith(template, 'auth')
        );
        expect(onSave).not.toHaveBeenCalled();
    });

    it('keeps the draft open when persistence fails', async () => {
        await open(vi.fn().mockRejectedValue(new Error('Save failed')));
        fireEvent.click(
            screen.getByRole('button', { name: 'common.actions.save' })
        );
        expect((await screen.findByRole('alert')).textContent).toBe(
            'Save failed'
        );
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
            template
        );
    });
});
