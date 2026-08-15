import { Router } from 'express';
import { verifyWhatsAppSignature } from '../middleware/verifyWhatsAppSignature.js';
import { verifyWebhook, receiveWebhookMessage } from '../controllers/webhook.controller.js';

const router = Router();

router.get('/', verifyWebhook);
router.post('/', verifyWhatsAppSignature, receiveWebhookMessage);

export default router;
