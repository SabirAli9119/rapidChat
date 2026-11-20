import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDb, disconnectTestDb } from '../helpers/db';
import { V1 } from '../helpers/http';

// These two lines run BEFORE any project file is loaded, because the project reads its settings only once.
// (Only non-project files are imported at the top of this file, and the app is imported below.)
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '3';
process.env.RATE_LIMIT_MAX_REQUESTS = '1000';

let app: Express;

beforeAll(async () => {
  const { createApp } = await import('../../src/app');
  app = createApp();
  await connectTestDb();
});
afterAll(disconnectTestDb);

describe('rate limits (3 attempts allowed in this file)', () => {
  it('block registration after repeated attempts, and say when to retry', async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await request(app).post(`${V1}/auth/register`).send({});
      expect(res.status).toBe(400); // allowed through, then refused by validation
    }

    const blocked = await request(app).post(`${V1}/auth/register`).send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.body.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('count failed logins on their own, separately from registration', async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await request(app).post(`${V1}/auth/login`).send({ identifier: `ghost${attempt}`, password: 'wrong-password-1' });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app).post(`${V1}/auth/login`).send({ identifier: 'ghost4', password: 'wrong-password-1' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
  });

  it('allow only 5 password-reset requests per hour', async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await request(app).post(`${V1}/auth/forgot-password`).send({ email: 'ghost@example.com' });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).post(`${V1}/auth/forgot-password`).send({ email: 'ghost@example.com' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
  });

  it('never block the health check', async () => {
    for (let attempt = 1; attempt <= 30; attempt++) {
      const res = await request(app).get(`${V1}/health`);
      expect(res.status).not.toBe(429);
    }
  });

  it('keep the registration block in place for later requests', async () => {
    const res = await request(app).post(`${V1}/auth/register`).send({});
    expect(res.status).toBe(429);
  });
});