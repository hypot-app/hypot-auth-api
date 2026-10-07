export const SCOPES = [
  'login_ip',
  'login_account_ip',
  'login_account',
  'email_ip',
  'reset_ip',
  'confirm_ip',
  'refresh_ip',
  'email_account',
] as const;

export type Scope = (typeof SCOPES)[number];
