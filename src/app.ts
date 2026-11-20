import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import routes from './routes';
import { ApiResponse } from './utils/ApiResponse';
import { logger } from './utils/logger';

/** The one website allowed to call this API from a browser. */
export const frontendOrigin = new URL(env.FRONTEND_URL).origin;

/** JSON bodies are tiny here (a message is at most 2000 characters). File uploads use multipart and have their own limit. */
export const JSON_BODY_LIMIT = '100kb';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Behind a reverse proxy (Nginx, Render, Railway...) req.ip would be the proxy's address for everyone,
  // which would make the rate limiters treat all users as one. "1" means: trust exactly one proxy hop.
  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  // Flat query strings only: "?a[b]=c" stays plain text instead of becoming a nested object
  app.set('query parser', 'simple');

  // ----- request logging (one line per request, with a request id for tracing) -----
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req: IncomingMessage, res: ServerResponse) => {
        const id = randomUUID(); // always generated here: a client-supplied id is never trusted
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error): 'error' | 'warn' | 'info' =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      // Monitors poll the health check constantly: keep it out of the logs
      autoLogging: { ignore: (req: IncomingMessage) => (req.url ?? '').split('?')[0] === '/api/v1/health' },
      serializers: {
        // The query string is dropped on purpose: signed media links carry a signature in it
        req: (req: { id?: unknown; method?: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          url: (req.url ?? '').split('?')[0],
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // ----- security -----
  app.use(helmet());
  app.use(
    cors({
      origin: frontendOrigin, // exactly one origin (never "*": cookies are involved)
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After', 'Content-Disposition'],
      maxAge: 600, // browsers may remember a preflight answer for 10 minutes
    }),
  );

  // Nothing under /api may be stored by browsers or proxies (the file download route sets its own stricter value)
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ----- parsing -----
  app.use(cookieParser(env.COOKIE_SECRET));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // ----- routes -----
  app.get('/', (_req, res) => {
    ApiResponse.ok(res, { health: '/api/v1/health' }, 'Nearby Chat API');
  });
  app.use('/api/v1', routes);

  // ----- errors (these two must come last) -----
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}