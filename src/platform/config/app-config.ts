import { z } from 'zod';

export const APP_CONFIG = Symbol('AppConfig');

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const baseUrl = z
  .string()
  .refine((value) => URL.canParse(value) && /^https?:\/\//.test(value), 'must be an absolute http(s) URL')
  .refine((value) => !value.endsWith('/'), 'must not end with a trailing slash');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1),
    AUTH_PUBLIC_BASE_URL: baseUrl,
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: booleanString.default(false),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    MAIL_FROM: z.string().min(1),
  })
  .superRefine((env, ctx) => {
    // Case-sensitive on purpose: the base rule already refuses any other spelling of the scheme.
    if (env.NODE_ENV === 'production' && !env.AUTH_PUBLIC_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_PUBLIC_BASE_URL'],
        message: 'must be an https URL in production',
      });
    }
    if ((env.SMTP_USER === undefined) !== (env.SMTP_PASS === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_USER'],
        message: 'SMTP_USER and SMTP_PASS must be set together or not at all',
      });
    }
  });

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  databaseUrl: string;
  authPublicBaseUrl: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string } | undefined;
  };
  mailFrom: string;
}

/** Thrown at startup when the environment is invalid. Never includes values. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Only keys and rule messages are reported, so secrets cannot leak into logs.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }
  const values = parsed.data;
  return {
    nodeEnv: values.NODE_ENV,
    isProduction: values.NODE_ENV === 'production',
    port: values.PORT,
    databaseUrl: values.DATABASE_URL,
    authPublicBaseUrl: values.AUTH_PUBLIC_BASE_URL,
    smtp: {
      host: values.SMTP_HOST,
      port: values.SMTP_PORT,
      secure: values.SMTP_SECURE,
      auth:
        values.SMTP_USER !== undefined && values.SMTP_PASS !== undefined
          ? { user: values.SMTP_USER, pass: values.SMTP_PASS }
          : undefined,
    },
    mailFrom: values.MAIL_FROM,
  };
}
