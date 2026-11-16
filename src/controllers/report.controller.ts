import type { Request, Response } from 'express';
import type { z } from 'zod';
import { requireUser } from '../middlewares/auth.middleware';
import * as reportService from '../services/report.service';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import type { CreateReportInput, listMyReportsSchema } from '../validators/report.validator';

type ListMyReportsQuery = z.infer<typeof listMyReportsSchema>['query'];

export const createReport = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const report = await reportService.createReport(me.id, req.body as CreateReportInput);
  ApiResponse.created(res, { report }, 'Report submitted. Thank you for helping keep the community safe.');
});

export const listMyReports = asyncHandler(async (req: Request, res: Response) => {
  const me = requireUser(req);
  const { items, ...meta } = await reportService.listMyReports(me.id, req.query as unknown as ListMyReportsQuery);
  ApiResponse.ok(res, items, 'Your reports', meta);
});