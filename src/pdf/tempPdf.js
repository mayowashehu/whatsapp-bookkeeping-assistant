import fs from 'node:fs/promises';

/**
 * Best-effort deletion of a temporary statement PDF.
 * Never throws — logs and continues so finally blocks stay safe.
 */
export async function deleteTempPdfFile(filePath) {
  if (!filePath) {
    return;
  }

  try {
    await fs.unlink(filePath);
    console.log(`[tempPdf] Deleted temporary PDF path=${filePath}`);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error(
        `[tempPdf] Failed to delete temporary PDF path=${filePath}: ${err.message}`,
      );
    }
  }
}

export default {
  deleteTempPdfFile,
};
