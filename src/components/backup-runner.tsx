"use client";

import { runDailyBackup } from "@/lib/backup-client";
import { initLocalDb } from "@/lib/local-db";
import { useEffect } from "react";

export default function BackupRunner() {
  useEffect(() => {
    let mounted = true;

    initLocalDb().catch(() => {
      // 初始化失败时不阻断页面
    });

    const tryRun = () => {
      if (!mounted) {
        return;
      }
      runDailyBackup(false).catch(() => {
        // 静默失败，等待自动重试
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        tryRun();
      }
    };

    tryRun();
    const timer = window.setInterval(tryRun, 5 * 60 * 1000);
    window.addEventListener("online", tryRun);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      mounted = false;
      window.clearInterval(timer);
      window.removeEventListener("online", tryRun);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
