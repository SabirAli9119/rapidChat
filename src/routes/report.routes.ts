import { Router } from 'express';
import * as reportController from '../controllers/report.controller';
import { authenticate, requireVerifiedEmail } from '../middlewares/auth.middleware';
import { validate } from '../middlewares/validation.middleware';
import { createReportSchema, listMyReportsSchema } from '../validators/report.validator';

const router = Router();

router.use(authenticate);

// Filing needs a verified account (throwaway unverified accounts can't spam reports)
router.post('/', requireVerifiedEmail, validate(createReportSchema), reportController.createReport);
router.get('/mine', validate(listMyReportsSchema), reportController.listMyReports);

export default router;