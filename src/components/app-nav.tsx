"use client";

import { runHardRefresh } from "@/lib/hard-refresh";
import { t } from "@/lib/i18n";
import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const NAV_ITEMS = [
  { href: "/quick", label: t("quickEntry") },
  { href: "/members", label: t("members") },
  { href: "/transactions", label: t("transactions") },
  { href: "/pricelist", label: t("priceList") },
  { href: "/sync", label: "數據同步" },
];

const NAV_BUTTON_BASE = "inline-flex h-10 items-center rounded-xl px-4 text-sm font-semibold";

export default function AppNav() {
  const pathname = usePathname();
  const [refreshing, setRefreshing] = useState(false);

  async function hardRefresh() {
    if (refreshing) {
      return;
    }
    setRefreshing(true);
    await runHardRefresh();
  }

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:px-8">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-slate-900">{t("appName")}</p>
          <p className="text-xs text-slate-500">本地離線模式（IndexedDB）</p>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                NAV_BUTTON_BASE,
                pathname === item.href
                  ? "bg-cyan-700 text-white"
                  : "bg-slate-100 text-slate-700",
              )}
            >
              {item.label}
            </Link>
          ))}
          <button
            type="button"
            onClick={() => {
              void hardRefresh();
            }}
            disabled={refreshing}
            className={clsx(
              NAV_BUTTON_BASE,
              "w-10 justify-center px-0",
              "bg-slate-100 text-slate-700 hover:bg-slate-200",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
            title="強制刷新（清快取）"
            aria-label="強制刷新（清快取）"
          >
            <span
              aria-hidden="true"
              className={clsx("text-base leading-none", refreshing && "animate-spin")}
            >
              ↻
            </span>
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1 md:hidden">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={clsx(
              NAV_BUTTON_BASE,
              "whitespace-nowrap",
              pathname === item.href
                ? "bg-cyan-700 text-white"
                : "bg-slate-100 text-slate-700",
            )}
          >
            {item.label}
          </Link>
        ))}
        <button
          type="button"
          onClick={() => {
            void hardRefresh();
          }}
          disabled={refreshing}
          className={clsx(
            NAV_BUTTON_BASE,
            "h-10 w-10 shrink-0 justify-center px-0",
            "bg-slate-100 text-slate-700",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
          title="強制刷新（清快取）"
          aria-label="強制刷新（清快取）"
        >
          <span
            aria-hidden="true"
            className={clsx("text-base leading-none", refreshing && "animate-spin")}
          >
            ↻
          </span>
        </button>
      </div>
    </header>
  );
}
