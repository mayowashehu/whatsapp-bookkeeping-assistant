import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentDeliveryManager } from '../whatsapp/delivery/DocumentDeliveryManager.js';
import { deliverStatementPdf } from '../whatsapp/delivery/deliverStatementPdf.js';

/**
 * Demonstrates document delivery success and failure scenarios with a mock Meta client.
 * Run: node src/scripts/demoDocumentDelivery.js
 */

async function writeTempPdf() {
  const pdfPath = path.join(os.tmpdir(), `demo-statement-${Date.now()}.pdf`);
  await fs.writeFile(pdfPath, Buffer.from('%PDF-1.4 demo statement content'));
  return pdfPath;
}

function createMockDocumentService(behavior) {
  return {
    async uploadDocument() {
      if (behavior.uploadError) {
        return { success: false, data: null, error: behavior.uploadError };
      }
      return { success: true, data: { mediaId: 'media-123' }, error: null };
    },
    async sendDocument() {
      if (behavior.sendError) {
        return { success: false, data: null, error: behavior.sendError };
      }
      return {
        success: true,
        data: { messageId: 'wamid.DEMO', mediaId: 'media-123' },
        error: null,
      };
    },
  };
}

const pdfPath = await writeTempPdf();
const results = [];

// 1) Success
{
  const manager = createDocumentDeliveryManager({
    documentService: createMockDocumentService({}),
  });
  const result = await manager.deliverDocument({
    phoneNumber: '+2348012345678',
    pdfPath,
    filename: 'Apartment-2-July-2026.pdf',
    caption: 'July statement',
  });
  results.push({ scenario: 'successful_delivery', result });
}

// 2) Upload failure
{
  const manager = createDocumentDeliveryManager({
    documentService: createMockDocumentService({
      uploadError: { code: 'UPLOAD_FAILURE', message: 'Simulated upload failure' },
    }),
  });
  results.push({
    scenario: 'upload_failure',
    result: await manager.deliverDocument({
      phoneNumber: '2348012345678',
      pdfPath,
      filename: 'statement.pdf',
    }),
  });
}

// 3) Send failure (after successful upload)
{
  const manager = createDocumentDeliveryManager({
    documentService: createMockDocumentService({
      sendError: { code: 'SEND_FAILURE', message: 'Simulated send failure' },
    }),
  });
  results.push({
    scenario: 'send_failure',
    result: await manager.deliverDocument({
      phoneNumber: '2348012345678',
      pdfPath,
      filename: 'statement.pdf',
    }),
  });
}

// 4) Timeout
{
  const manager = createDocumentDeliveryManager({
    documentService: createMockDocumentService({
      uploadError: {
        code: 'WHATSAPP_TIMEOUT',
        message: 'Meta API request timed out after 30000ms',
      },
    }),
  });
  results.push({
    scenario: 'timeout',
    result: await manager.deliverDocument({
      phoneNumber: '2348012345678',
      pdfPath,
      filename: 'statement.pdf',
    }),
  });
}

// 5) Authentication failure
{
  const manager = createDocumentDeliveryManager({
    documentService: createMockDocumentService({
      uploadError: {
        code: 'WHATSAPP_AUTH_ERROR',
        message: 'WhatsApp authentication failed: Invalid OAuth access token',
      },
    }),
  });
  results.push({
    scenario: 'authentication_failure',
    result: await manager.deliverDocument({
      phoneNumber: '2348012345678',
      pdfPath,
      filename: 'statement.pdf',
    }),
  });
}

// 6) Invalid phone number
{
  const manager = createDocumentDeliveryManager({
    documentService: createMockDocumentService({}),
  });
  results.push({
    scenario: 'invalid_phone_number',
    result: await manager.deliverDocument({
      phoneNumber: 'abc',
      pdfPath,
      filename: 'statement.pdf',
    }),
  });
}

// 7) Missing PDF
{
  const manager = createDocumentDeliveryManager({
    documentService: createMockDocumentService({}),
  });
  results.push({
    scenario: 'missing_pdf',
    result: await manager.deliverDocument({
      phoneNumber: '2348012345678',
      pdfPath: path.join(os.tmpdir(), 'does-not-exist.pdf'),
      filename: 'statement.pdf',
    }),
  });
}

// Helper smoke test
{
  const helperResult = await deliverStatementPdf({
    phoneNumber: '+2348012345678',
    pdfPath,
    filename: 'property-statement.pdf',
    deliveryManager: createDocumentDeliveryManager({
      documentService: createMockDocumentService({}),
    }),
  });
  results.push({ scenario: 'statement_helper_success', result: helperResult });
}

await fs.unlink(pdfPath).catch(() => {});

console.log(JSON.stringify({ ok: true, results }, null, 2));
