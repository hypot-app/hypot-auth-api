import { isIP } from 'node:net';
import { z } from 'zod';

export const APP_CONFIG = Symbol('AppConfig');

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const baseUrl = z
  .string()
  .refine((value) => URL.canParse(value) && /^https?:\/\//.test(value), 'must be an absolute http(s) URL')
  .refine((value) => !value.endsWith('/'), 'must not end with a trailing slash')
  // The value is copied verbatim into `iss` and the JWKS URL is built by appending a path (ADR 43).
  .refine((value) => !/[?#]/.test(value), 'must not contain a query or a fragment');

const EXPRESS_PROXY_NAMES = ['loopback', 'linklocal', 'uniquelocal'];
/** No real proxy chain is longer, and an overstated count lets a client-supplied address win (ADR 37). */
const MAX_TRUSTED_HOPS = 10;
/** Narrower than this and a CIDR trusts a whole provider rather than a proxy fleet. */
const MIN_PREFIX_V4 = 8;
const MIN_PREFIX_V6 = 16;

/**
 * `false`, a hop count up to 10, or a comma-separated list of Express names, IPs and CIDRs no wider than
 * /8 (IPv4) or /16 (IPv6). `true` trusts every client.
 */
function isValidTrustProxy(value: string): boolean {
  if (value === 'false') return true;
  if (/^\d+$/.test(value)) return Number(value) >= 1 && Number(value) <= MAX_TRUSTED_HOPS;
  return value.split(',').every((raw) => {
    const entry = raw.trim();
    if (EXPRESS_PROXY_NAMES.includes(entry)) return true;
    const [address = '', prefix, ...extra] = entry.split('/');
    const version = isIP(address);
    if (version === 0 || extra.length > 0) return false;
    if (prefix === undefined) return true;
    // /0 would trust every address, which is `true` by another name; the floor stops its near relatives.
    const bounds = version === 4 ? ([MIN_PREFIX_V4, 32] as const) : ([MIN_PREFIX_V6, 128] as const);
    return /^\d+$/.test(prefix) && Number(prefix) >= bounds[0] && Number(prefix) <= bounds[1];
  });
}

const trustProxy = z
  .string()
  .default('false')
  .refine(
    isValidTrustProxy,
    'must be false, a hop count of 1 to 10, or trusted proxy names or CIDRs no wider than /8 (IPv4) or /16 (IPv6); true is not allowed',
  )
  .transform((value): boolean | number | string => {
    if (value === 'false') return false;
    return /^\d+$/.test(value) ? Number(value) : value;
  });

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
    TRUST_PROXY: trustProxy,
  })
  .superRefine((env, ctx) => {
    // Parsed, so this guard does not depend on the base rule's scheme regex.
    if (env.NODE_ENV === 'production' && new URL(env.AUTH_PUBLIC_BASE_URL).protocol !== 'https:') {
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
  /** Value for Express `trust proxy` (ADR 37). Never `true`. */
  trustProxy: boolean | number | string;
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
    trustProxy: values.TRUST_PROXY,
  };
}
