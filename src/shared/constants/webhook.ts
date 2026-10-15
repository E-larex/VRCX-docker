import genericWebhookFields from '../../../crates/application-activity/src/notification/webhook-generic-fields.json';

export const GENERIC_WEBHOOK_FIELDS = Object.freeze(
    genericWebhookFields.map((field) => String(field))
);

export const DEFAULT_GENERIC_WEBHOOK_FIELDS = JSON.stringify(
    GENERIC_WEBHOOK_FIELDS
);

export { default as WEBHOOK_TEMPLATE_VARIABLES } from '../../../crates/application-activity/src/notification/webhook-template-variables.json';
import defaultWebhookTemplate from '../../../crates/application-activity/src/notification/webhook-template-default.j2?raw';
export const DEFAULT_WEBHOOK_TEMPLATE = defaultWebhookTemplate;
