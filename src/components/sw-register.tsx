"use client";

import { useEffect } from "react";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((registration) => {
          registration.unregister().catch(() => {
            // ignore
          });
        });
      });
      return;
    }

    navigator.serviceWorker.register("/sw.js").catch(() => {
      // PWA 注册失败不影响主流程。
    });
  }, []);

  return null;
}
