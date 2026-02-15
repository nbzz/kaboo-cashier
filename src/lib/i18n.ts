import { zhHk } from "@/i18n/zh-hk";

export type LocaleCode = "zh-HK" | "zh-CN" | "en";

// 目前只启用繁体中文，结构先预留给简中/英文。
const dictionaries: Record<LocaleCode, typeof zhHk> = {
  "zh-HK": zhHk,
  "zh-CN": zhHk,
  en: zhHk,
};

export function t(key: keyof typeof zhHk, locale: LocaleCode = "zh-HK") {
  return dictionaries[locale][key] ?? dictionaries["zh-HK"][key];
}
