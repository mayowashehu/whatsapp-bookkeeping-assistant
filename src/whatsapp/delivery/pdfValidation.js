import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Validates a local PDF before any Meta upload request.
 */
export async function validatePdfFile(pdfPath) {
  if (!pdfPath || typeof pdfPath !== 'string') {
    return {
      ok: false,
      error: {
        code: 'PDF_MISSING',
        message: 'pdfPath is required',
      },
    };
  }

  let stat;
  try {
    stat = await fs.stat(pdfPath);
  } catch {
    return {
      ok: false,
      error: {
        code: 'PDF_MISSING',
        message: `PDF file not found: ${pdfPath}`,
      },
    };
  }

  if (!stat.isFile()) {
    return {
      ok: false,
      error: {
        code: 'PDF_MISSING',
        message: `PDF path is not a file: ${pdfPath}`,
      },
    };
  }

  if (stat.size <= 0) {
    return {
      ok: false,
      error: {
        code: 'PDF_INVALID',
        message: 'PDF file is empty',
      },
    };
  }

  const extension = path.extname(pdfPath).toLowerCase();
  if (extension !== '.pdf') {
    return {
      ok: false,
      error: {
        code: 'PDF_INVALID_MIME',
        message: 'File extension must be .pdf',
      },
    };
  }

  let handle;
  try {
    handle = await fs.open(pdfPath, 'r');
    const { buffer } = await handle.read(Buffer.alloc(5), 0, 5, 0);
    const magic = buffer.toString('utf8');
    if (!magic.startsWith('%PDF')) {
      return {
        ok: false,
        error: {
          code: 'PDF_INVALID_MIME',
          message: 'File content is not a valid PDF (missing %PDF header)',
        },
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'PDF_UNREADABLE',
        message: `PDF file is not readable: ${err.message}`,
      },
    };
  } finally {
    if (handle) {
      await handle.close();
    }
  }

  return {
    ok: true,
    mimeType: 'application/pdf',
    size: stat.size,
    error: null,
  };
}

export default {
  validatePdfFile,
};
