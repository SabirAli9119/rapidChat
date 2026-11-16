import type { Response } from 'express';

export interface ApiSuccessBody<T> {
  success: true;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
}

export class ApiResponse {
  /** 200 OK */
  static ok<T>(res: Response, data: T, message = 'Success', meta?: Record<string, unknown>): Response {
    const body: ApiSuccessBody<T> = { success: true, message, data, ...(meta ? { meta } : {}) };
    return res.status(200).json(body);
  }

  /** 201 Created */
  static created<T>(res: Response, data: T, message = 'Created successfully'): Response {
    const body: ApiSuccessBody<T> = { success: true, message, data };
    return res.status(201).json(body);
  }

  /** 204 No Content (nothing in the body) */
  static noContent(res: Response): Response {
    return res.status(204).send();
  }
}