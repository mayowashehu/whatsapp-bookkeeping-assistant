import { Router } from 'express';
import healthRoutes from './health.routes.js';
import webhookRoutes from './webhook.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/webhook', webhookRoutes);

export default router;
