import type { CurrencyCode } from "@/lib/types";

export const CURRENCY_OPTIONS: Array<{ code: CurrencyCode; label: string }> = [
  { code: "HKD", label: "港幣 HKD" },
  { code: "CNY", label: "人民幣 CNY" },
  { code: "USD", label: "美元 USD" },
  { code: "EUR", label: "歐元 EUR" },
  { code: "GBP", label: "英鎊 GBP" },
  { code: "JPY", label: "日圓 JPY" },
  { code: "SGD", label: "新加坡幣 SGD" },
  { code: "AUD", label: "澳元 AUD" },
];

const CURRENCY_KEY = "config:currency-code:v1";
const CURRENCY_SET = new Set<CurrencyCode>(CURRENCY_OPTIONS.map((item) => item.code));
let cachedCurrency: CurrencyCode = "HKD";

export function normalizeCurrencyCode(code: string | undefined | null): CurrencyCode {
  const candidate = String(code ?? "").toUpperCase() as CurrencyCode;
  return CURRENCY_SET.has(candidate) ? candidate : "HKD";
}

export function getPreferredCurrencyCode() {
  if (typeof window === "undefined") {
    return cachedCurrency;
  }
  const stored = localStorage.getItem(CURRENCY_KEY);
  const normalized = normalizeCurrencyCode(stored);
  cachedCurrency = normalized;
  return normalized;
}

export function setPreferredCurrencyCode(code: string) {
  const normalized = normalizeCurrencyCode(code);
  cachedCurrency = normalized;
  if (typeof window !== "undefined") {
    localStorage.setItem(CURRENCY_KEY, normalized);
  }
  return normalized;
}

export function nowHongKong() {
  const now = new Date();
  const hkDate = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" }),
  );
  const year = hkDate.getFullYear();
  const month = String(hkDate.getMonth() + 1).padStart(2, "0");
  const day = String(hkDate.getDate()).padStart(2, "0");
  const hour = String(hkDate.getHours()).padStart(2, "0");
  const minute = String(hkDate.getMinutes()).padStart(2, "0");
  const second = String(hkDate.getSeconds()).padStart(2, "0");

  return {
    createdAt: hkDate.toISOString(),
    bizDate: `${year}-${month}-${day}`,
    bizTime: `${hour}:${minute}`,
    fullTime: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
  };
}

export function formatCurrency(value: number, currencyCode?: string) {
  const code = normalizeCurrencyCode(currencyCode ?? getPreferredCurrencyCode());
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: 2,
  }).format(value);
}
