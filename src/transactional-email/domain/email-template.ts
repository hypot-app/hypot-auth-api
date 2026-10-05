/** The auth emails the service sends. Each has a default template set (U4b). */
export const EMAIL_TEMPLATES = [
  'confirmation',
  'welcome',
  'password-reset',
  'password-changed',
  'account-exists',
] as const;

export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];
