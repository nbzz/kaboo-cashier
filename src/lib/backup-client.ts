import {
  hasReadyBackupMailSettings,
  loadBackupMailSettings,
  parseRecipientList,
} from "@/lib/backup-settings";
import { exportMemberBackupWorkbookBase64 } from "@/lib/member-ledger-export";
import { exportStoreLedgerWorkbookBase64 } from "@/lib/store-ledger-export";
import { nowHongKong } from "@/lib/time";

const LAST_SUCCESS_DATE_KEY = "backup:last-success-date";
const LAST_ATTEMPT_TS_KEY = "backup:last-attempt-ts";
const DEVICE_ID_KEY = "backup:device-id";
const RETRY_INTERVAL_MS = 30 * 60 * 1000;

let running = false;

export type BackupRunResult = "success" | "skipped" | "missing-config" | "failed";

function getDeviceId() {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }
  const generated = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, generated);
  return generated;
}

function shouldRunToday(force = false) {
  if (force) {
    return true;
  }
  const today = nowHongKong().bizDate;
  const successDate = localStorage.getItem(LAST_SUCCESS_DATE_KEY);
  return successDate !== today;
}

function canRetry(force = false) {
  if (force) {
    return true;
  }
  const lastAttempt = Number(localStorage.getItem(LAST_ATTEMPT_TS_KEY) ?? "0");
  return Date.now() - lastAttempt >= RETRY_INTERVAL_MS;
}

export async function runDailyBackup(force = false): Promise<BackupRunResult> {
  if (running || !navigator.onLine) {
    return "skipped";
  }

  if (!shouldRunToday(force) || !canRetry(force)) {
    return "skipped";
  }

  const smtp = loadBackupMailSettings();
  if (!hasReadyBackupMailSettings(smtp)) {
    return force ? "missing-config" : "skipped";
  }

  running = true;
  localStorage.setItem(LAST_ATTEMPT_TS_KEY, String(Date.now()));

  try {
    const backupDate = nowHongKong().bizDate;
    const [memberXlsxBase64, storeXlsxBase64] = await Promise.all([
      exportMemberBackupWorkbookBase64(),
      exportStoreLedgerWorkbookBase64("ALL"),
    ]);

    const response = await fetch("/api/backup/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: getDeviceId(),
        backup_date: backupDate,
        smtp: {
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          user: smtp.user,
          pass: smtp.pass,
          from: smtp.from,
          to: parseRecipientList(smtp.to).join(","),
        },
        attachments: [
          {
            filename: `members-full-${backupDate}.xlsx`,
            content_type:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            content_base64: memberXlsxBase64,
          },
          {
            filename: `store-ledger-full-${backupDate}.xlsx`,
            content_type:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            content_base64: storeXlsxBase64,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error("backup-failed");
    }

    localStorage.setItem(LAST_SUCCESS_DATE_KEY, nowHongKong().bizDate);
    return "success";
  } catch {
    return "failed";
  } finally {
    running = false;
  }
}
