import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STALE_THRESHOLD_MS = 60 * 60 * 1000;

export function purgeStaleTempFiles() {
  const tmpDir = os.tmpdir();

  fs.readdir(tmpDir, (err, files) => {
    if (err) {
      console.error('[CLEANUP ERROR] Failed to read temporary directory:', err);
      return;
    }

    let deletedCount = 0;
    const now = Date.now();

    for (const file of files) {
      if (!file.toLowerCase().endsWith('.pdf')) {
        continue;
      }

      const filePath = path.join(tmpDir, file);

      try {
        const stats = fs.statSync(filePath);
        const fileAge = now - stats.mtimeMs;

        if (fileAge > STALE_THRESHOLD_MS) {
          fs.unlinkSync(filePath);
          deletedCount += 1;
        }
      } catch (fileErr) {
        if (fileErr.code !== 'EBUSY' && fileErr.code !== 'EPERM') {
          console.error(`[CLEANUP WARN] Could not process file ${file}:`, fileErr.message);
        }
      }
    }

    if (deletedCount > 0) {
      console.log(
        `[CLEANUP] Purged ${deletedCount} stale temporary statement PDF(s) from disk.`,
      );
    }
  });
}

export function startTempCleanupCron() {
  purgeStaleTempFiles();

  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  const intervalId = setInterval(purgeStaleTempFiles, TWELVE_HOURS);

  if (typeof intervalId.unref === 'function') {
    intervalId.unref();
  }
}

export default {
  purgeStaleTempFiles,
  startTempCleanupCron,
};
