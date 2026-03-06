"use client";

import { runHardRefresh } from "@/lib/hard-refresh";
import { useEffect, useState } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [fixing, setFixing] = useState(false);

  useEffect(() => {
    // 方便远程排错时让用户截图看到关键信息
    console.error("Global runtime error:", error);
  }, [error]);

  async function handleHardFix() {
    if (fixing) {
      return;
    }
    setFixing(true);
    await runHardRefresh();
  }

  return (
    <html lang="zh-HK">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-5 py-10">
          <section className="w-full rounded-2xl border border-rose-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-semibold text-rose-700">系統發生錯誤</p>
            <h1 className="mt-2 text-xl font-bold">頁面載入失敗</h1>
            <p className="mt-2 text-sm text-slate-600">
              你可以先按「一鍵修復重開」。這會清掉快取並重開 App，通常能恢復。
            </p>

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={handleHardFix}
                disabled={fixing}
                className="h-11 rounded-xl bg-cyan-700 px-4 text-sm font-semibold text-white disabled:opacity-60"
              >
                {fixing ? "修復中..." : "一鍵修復重開"}
              </button>
              <button
                type="button"
                onClick={reset}
                className="h-11 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700"
              >
                再試一次
              </button>
            </div>

            {error?.digest && (
              <p className="mt-4 text-xs text-slate-400">錯誤代碼：{error.digest}</p>
            )}
          </section>
        </main>
      </body>
    </html>
  );
}
