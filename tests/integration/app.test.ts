import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { redis } from '../../src/config/redis';
import { connectTestDb, disconnectTestDb } from '../helpers/db';
import { V1 } from '../helpers/http';

const app = createApp();
const FRONTEND = 'http://localhost:5173';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

describe('health check', () => {
  it('reports 503 while Redis is down, and says which part is down', async () => {
    const res = await request(app).get(`${V1}/health`);
    expect(res.status).toBe(503);
    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.checks).toEqual({ mongodb: 'up', redis: 'down' });
  });

  it('reports 200 when both MongoDB and Redis are up', async () => {
    const connection = redis as unknown as { status: string };
    connection.status = 'ready'; // pretend Redis is connected for this one request
    try {
      const res = await request(app).get(`${V1}/health`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'ok', checks: { mongodb: 'up', redis: 'up' } });
    } finally {
      connection.status = 'wait';
    }
  });

  it('is never cached and never rate limited', async () => {
    const res = await request(app).get(`${V1}/health`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['ratelimit']).toBeUndefined();
    expect(res.headers['ratelimit-policy']).toBeUndefined();
  });
});

describe('responses', () => {
  it('answers the root address with JSON', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { health: `${V1}/health` } });
  });

  it('answers an unknown URL with a JSON 404', async () => {
    const res = await request(app).get(`${V1}/nope`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'ROUTE_NOT_FOUND' });
  });

  it('never lets API answers be cached, and does not advertise Express', async () => {
    const res = await request(app).get(`${V1}/nope`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets the security headers', async () => {
    const res = await request(app).get(`${V1}/nope`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeTruthy();
    expect(res.headers['x-frame-options']).toBeTruthy();
  });

  it('gives every response its own request id', async () => {
    const first = await request(app).get(`${V1}/nope`);
    const second = await request(app).get(`${V1}/nope`);
    expect(first.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  it('answers broken JSON with a clean 400', async () => {
    const res = await request(app).post(`${V1}/auth/login`).set('Content-Type', 'application/json').send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MALFORMED_JSON');
  });

  it('answers a body over 100 KB with a clean 413', async () => {
    const res = await request(app).post(`${V1}/auth/login`).send({ identifier: 'x'.repeat(150_000), password: 'x' });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('CORS', () => {
  it('lets your frontend call the API with cookies', async () => {
    const res = await request(app)
      .options(`${V1}/auth/login`)
      .set('Origin', FRONTEND)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('gives no permission to any other website', async () => {
    const res = await request(app)
      .options(`${V1}/auth/login`)
      .set('Origin', 'http://evil.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).not.toBe('http://evil.example');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('lets your frontend read the request id header', async () => {
    const res = await request(app).get(`${V1}/health`).set('Origin', FRONTEND);
    expect(String(res.headers['access-control-expose-headers'])).toContain('X-Request-Id');
  });
});