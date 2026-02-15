"use client";

import { t } from "@/lib/i18n";
import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/quick", label: t("quickEntry") },
  { href: "/members", label: t("members") },
  { href: "/transactions", label: t("transactions") },
  { href: "/pricelist", label: t("priceList") },
  { href: "/sync", label: "數據同步" },
];

export default function AppNav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:px-8">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-slate-900">{t("appName")}</p>
          <p className="text-xs text-slate-500">本地離線模式（IndexedDB）</p>
        </div>
        <div className="hidden gap-2 md:flex">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "rounded-xl px-4 py-2 text-sm font-semibold",
                pathname === item.href
                  ? "bg-cyan-700 text-white"
                  : "bg-slate-100 text-slate-700",
              )}
            >
              {item.label}
            </Link>
          ))}
        </div>
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1 md:hidden">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={clsx(
              "whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold",
              pathname === item.href
                ? "bg-cyan-700 text-white"
                : "bg-slate-100 text-slate-700",
            )}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </header>
  );
}
