
import 'dotenv/config';
import { z } from 'zod';

/**
 * Converts "true"/"false" environment strings into booleans.
 */
const booleanString = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');

const envSchema = z
  .object({
    // ===== App =====
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),

    PORT: z.coerce.number().int().min(1).max(65535).default(5000),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    TRUST_PROXY: booleanString('false'),
    RUN_WORKERS_IN_SERVER: booleanString('true'),

    FRONTEND_URL: z.string().url().default('http://localhost:5173'),

    // ===== Databases =====
    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

    // ===== Auth =====
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),

    JWT_REFRESH_SECRET: z
      .string()
      .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),

    COOKIE_SECRET: z
      .string()
      .min(32, 'COOKIE_SECRET must be at least 32 characters'),

    COOKIE_DOMAIN: z.string().optional(),

    JWT_ACCESS_EXPIRES_IN_MINUTES: z.coerce.number().int().positive().default(15),

    JWT_REFRESH_EXPIRES_IN_DAYS: z.coerce.number().int().positive().default(7),

    EMAIL_VERIFICATION_EXPIRES_HOURS: z.coerce.number().int().positive().default(24),

    PASSWORD_RESET_EXPIRES_MINUTES: z.coerce.number().int().positive().default(30),

    // ===== Cloudinary =====
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),

    // ===== Email =====
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),

    EMAIL_FROM: z
      .string()
      .default('Nearby Chat <no-reply@nearbychat.local>'),

    // ===== Feature rules =====
    MESSAGE_EXPIRY_MINUTES: z.coerce.number().int().positive().default(30),

    MAX_FILE_SIZE_MB: z.coerce.number().positive().max(10).default(10),

    NEARBY_MAX_RADIUS_KM: z.coerce.number().positive().max(5).default(5),

    LOCATION_RETENTION_MINUTES: z.coerce.number().int().positive().default(15),

    SIGNED_URL_EXPIRY_SECONDS: z.coerce.number().int().positive().default(300),

    // ===== Rate limiting =====
    RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(300),

    AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),

    // ===== First admin =====
    SEED_ADMIN_EMAIL: z.string().email().optional(),

    SEED_ADMIN_PASSWORD: z
      .string()
      .min(12, 'SEED_ADMIN_PASSWORD must be at least 12 characters')
      .optional(),

    SEED_ADMIN_USERNAME: z
      .string()
      .trim()
      .toLowerCase()
      .min(3, 'SEED_ADMIN_USERNAME must be at least 3 characters')
      .max(30, 'SEED_ADMIN_USERNAME must be at most 30 characters')
      .regex(
        /^[a-z0-9_]+$/,
        'SEED_ADMIN_USERNAME may only contain letters, numbers and underscores',
      )
      .default('sysadmin'),
  })
  .superRefine((data, ctx) => {
    // Access and refresh secrets must be different.
    if (data.JWT_ACCESS_SECRET === data.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must be different from JWT_ACCESS_SECRET',
      });
    }

    // Production configuration validation.
    if (data.NODE_ENV === 'production') {
      const requiredInProduction = [
        'CLOUDINARY_CLOUD_NAME',
        'CLOUDINARY_API_KEY',
        'CLOUDINARY_API_SECRET',
        'SMTP_HOST',
        'SMTP_PORT',
        'SMTP_USER',
        'SMTP_PASS',
      ] as const;

      for (const key of requiredInProduction) {
        if (!data[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when NODE_ENV=production`,
          });
        }
      }
    }
  });

/**
 * Remove empty environment variables so optional values
 * can correctly use their defaults or remain undefined.
 */
const rawEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([, value]) => value !== undefined && value.trim() !== '',
  ),
);

/**
 * Validate environment variables.
 */
const parsed = envSchema.safeParse(rawEnv);

if (!parsed.success) {
  console.error('\n❌ Invalid environment configuration:\n');

  for (const issue of parsed.error.issues) {
    console.error(
      `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
  }

  console.error(
    '\nFix your .env file (compare it with .env.example) and restart.\n',
  );

  process.exit(1);
}

/**
 * Export validated environment configuration.
 */
export const env = parsed.data;

export type Env = typeof env;

// ===== Environment helpers =====

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
