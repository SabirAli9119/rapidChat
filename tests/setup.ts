/**
 * Runs before every test file and BEFORE any project file is loaded.
 * The project reads its settings once, at start-up (src/config/env.ts), so everything it needs is set here.
 * Values that exist in your .env are overridden, so the tests behave the same on every machine.
 */
const testEnvironment: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  PORT: '5000',
  TRUST_PROXY: 'false',
  RUN_WORKERS_IN_SERVER: 'false',
  FRONTEND_URL: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/not-used-in-tests',
  REDIS_URL: 'redis://127.0.0.1:6379',

  JWT_ACCESS_SECRET: 'a'.repeat(64),
  JWT_REFRESH_SECRET: 'b'.repeat(64),
  COOKIE_SECRET: 'c'.repeat(64),
  JWT_ACCESS_EXPIRES_IN_MINUTES: '15',
  JWT_REFRESH_EXPIRES_IN_DAYS: '7',
  EMAIL_VERIFICATION_EXPIRES_HOURS: '24',
  PASSWORD_RESET_EXPIRES_MINUTES: '30',

  // Fake storage keys: the tests replace the storage calls, so nothing is ever uploaded
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: '123456',
  CLOUDINARY_API_SECRET: 'test-secret',

  // Blank on purpose: with no SMTP settings the app never tries to send a real email
  SMTP_HOST: '',
  SMTP_PORT: '',
  SMTP_USER: '',
  SMTP_PASS: '',
  EMAIL_FROM: 'Nearby Chat <no-reply@nearbychat.local>',
  COOKIE_DOMAIN: '',
  SEED_ADMIN_EMAIL: '',
  SEED_ADMIN_PASSWORD: '',

  MESSAGE_EXPIRY_MINUTES: '30',
  MAX_FILE_SIZE_MB: '10',
  NEARBY_MAX_RADIUS_KM: '5',
  LOCATION_RETENTION_MINUTES: '15',
  SIGNED_URL_EXPIRY_SECONDS: '300',

  // High, so ordinary tests never trip a limit. tests/integration/ratelimit.test.ts lowers them on purpose.
  RATE_LIMIT_WINDOW_MINUTES: '15',
  RATE_LIMIT_MAX_REQUESTS: '10000',
  AUTH_RATE_LIMIT_MAX_REQUESTS: '1000',
};

for (const [name, value] of Object.entries(testEnvironment)) {
  process.env[name] = value;
}