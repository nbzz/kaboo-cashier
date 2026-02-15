"use client";

import {
  deletePriceItemLocal,
  deletePriceItemsByCategoryLocal,
  getConfigLocal,
  getPriceListLocal,
  getStoreProfileLocal,
  replacePriceListLocal,
  saveConfigLocal,
  saveStoreProfileLocal,
  upsertPriceItemLocal,
} from "@/lib/local-db";
import { CURRENCY_OPTIONS, nowHongKong } from "@/lib/time";
import type { ConfigRules, DiscountTier, PriceItem, StoreProfile } from "@/lib/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

interface NewItemForm {
  item_name: string;
  item_name_en: string;
  category: string;
  category_en: string;
  original_price: string;
  share_price: string;
  notes: string;
  active: boolean;
}

const EMPTY_NEW_ITEM: NewItemForm = {
  item_name: "",
  item_name_en: "",
  category: "",
  category_en: "",
  original_price: "",
  share_price: "",
  notes: "",
  active: true,
};

export default function PriceListPanel() {
  const [items, setItems] = useState<PriceItem[]>([]);
  const [storeProfile, setStoreProfile] = useState<StoreProfile | null>(null);
  const [configRules, setConfigRules] = useState<ConfigRules | null>(null);
  const [quickAmountsInput, setQuickAmountsInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [renameCategoryFrom, setRenameCategoryFrom] = useState("");
  const [renameCategoryTo, setRenameCategoryTo] = useState("");
  const [deleteCategoryName, setDeleteCategoryName] = useState("");
  const [editingItemId, setEditingItemId] = useState("");
  const [editingDraft, setEditingDraft] = useState<PriceItem | null>(null);
  const [showCreateRow, setShowCreateRow] = useState(false);
  const [newItem, setNewItem] = useState<NewItemForm>(EMPTY_NEW_ITEM);
  const toastTimer = useRef<number | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const categories = useMemo(
    () => Array.from(new Set(items.map((item) => item.category))).filter(Boolean),
    [items],
  );

  const filtered = useMemo(() => {
    if (!filterCategory) return items;
    return items.filter((item) => item.category === filterCategory);
  }, [items, filterCategory]);

  const showToast = useCallback((text: string, type: "success" | "error") => {
    if (toastTimer.current) {
      window.clearTimeout(toastTimer.current);
    }
    if (type === "error") {
      setError(text);
      setMessage("");
    } else {
      setMessage(text);
      setError("");
    }
    toastTimer.current = window.setTimeout(() => {
      setMessage("");
      setError("");
    }, 2800);
  }, []);

  const loadPriceList = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [rows, profile, config] = await Promise.all([
        getPriceListLocal(),
        getStoreProfileLocal(),
        getConfigLocal(),
      ]);
      setItems(rows);
      setStoreProfile(profile);
      setConfigRules(config);
      setQuickAmountsInput((config.topupQuickAmounts ?? []).join(","));
      const firstCategory = rows[0]?.category ?? "";
      setRenameCategoryFrom((prev) => prev || firstCategory);
      setDeleteCategoryName((prev) => prev || firstCategory);
    } catch (loadError) {
      showToast(loadError instanceof Error ? loadError.message : "讀取價目表失敗", "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadPriceList().catch(() => {
      // ignore
    });
    return () => {
      if (toastTimer.current) {
        window.clearTimeout(toastTimer.current);
      }
    };
  }, [loadPriceList]);

  useEffect(() => {
    if (newItem.category) {
      return;
    }
    if (filterCategory) {
      setNewItem((prev) => ({ ...prev, category: filterCategory }));
      return;
    }
    if (categories.length > 0) {
      setNewItem((prev) => ({ ...prev, category: categories[0] }));
    }
  }, [newItem.category, filterCategory, categories]);

  function normalizePriceItemForSave(item: PriceItem): PriceItem {
    const category = item.category.trim();
    const itemName = item.item_name.trim();
    return {
      ...item,
      category,
      item_name: itemName,
      category_en: item.category_en?.trim() || "",
      item_name_en: item.item_name_en?.trim() || "",
    };
  }

  function formatTierLabel(rate: number) {
    if (!Number.isFinite(rate) || rate >= 1) {
      return "原價";
    }
    const text = (rate * 10).toFixed(rate * 10 % 1 === 0 ? 0 : 1);
    return `${text}折`;
  }

  function normalizeDiscountTiers(tiers: DiscountTier[]) {
    const filtered = tiers
      .map((item) => ({ threshold: Number(item.threshold), rate: Number(item.rate) }))
      .filter(
        (item) =>
          Number.isFinite(item.threshold) &&
          item.threshold > 0 &&
          Number.isFinite(item.rate) &&
          item.rate > 0 &&
          item.rate <= 1,
      );
    const dedupMap = new Map<number, number>();
    filtered.forEach((item) => dedupMap.set(Math.round(item.threshold), item.rate));
    return Array.from(dedupMap.entries())
      .map(([threshold, rate]) => ({ threshold, rate }))
      .sort((a, b) => b.threshold - a.threshold);
  }

  async function saveItem(item: PriceItem) {
    const trimmedName = item.item_name.trim();
    const trimmedCategory = item.category.trim();
    if (!trimmedName) {
      showToast("項目名不能為空", "error");
      return false;
    }
    if (!trimmedCategory) {
      showToast("請選擇分類", "error");
      return false;
    }
    try {
      const nextItem: PriceItem = normalizePriceItemForSave({
        ...item,
        item_name: trimmedName,
        category: trimmedCategory,
      });
      await upsertPriceItemLocal(nextItem);
      setItems((prev) =>
        prev.map((row) => (row.item_id === nextItem.item_id ? nextItem : row)),
      );
      showToast(`已保存：${nextItem.item_name}`, "success");
      return true;
    } catch (saveError) {
      showToast(saveError instanceof Error ? saveError.message : "保存失敗", "error");
      return false;
    }
  }

  function startEditItem(item: PriceItem) {
    setEditingItemId(item.item_id);
    setEditingDraft({ ...item });
  }

  function cancelEditItem() {
    setEditingItemId("");
    setEditingDraft(null);
  }

  async function saveEditingItem() {
    if (!editingDraft || !editingItemId) {
      return;
    }
    const ok = await saveItem(editingDraft);
    if (ok) {
      cancelEditItem();
    }
  }

  async function addCategory() {
    const nextName = newCategoryName.trim();
    if (!nextName) {
      showToast("請輸入分類名稱", "error");
      return;
    }
    if (categories.includes(nextName)) {
      showToast("分類已存在", "error");
      return;
    }

    const placeholderItem: PriceItem = {
      item_id: `custom_${crypto.randomUUID()}`,
      category: nextName,
      category_en: "",
      item_name: "新項目（請改名）",
      item_name_en: "",
      original_price: "-",
      share_price: "-",
      active: true,
      notes: "",
    };

    try {
      await upsertPriceItemLocal(placeholderItem);
      setItems((prev) => [...prev, placeholderItem]);
      setFilterCategory(nextName);
      setNewCategoryName("");
      setRenameCategoryFrom(nextName);
      setDeleteCategoryName(nextName);
      setNewItem((prev) => ({
        ...prev,
        category: nextName,
      }));
      showToast(`已新增分類：${nextName}`, "success");
    } catch (addError) {
      showToast(addError instanceof Error ? addError.message : "新增分類失敗", "error");
    }
  }

  async function renameCategory() {
    const from = renameCategoryFrom.trim();
    const to = renameCategoryTo.trim();
    if (!from || !to) {
      showToast("請選擇舊分類並輸入新名稱", "error");
      return;
    }
    if (from === to) {
      showToast("新舊分類名稱相同，無需修改", "error");
      return;
    }
    if (categories.includes(to)) {
      showToast("新分類名稱已存在", "error");
      return;
    }

    const targets = items.filter((item) => item.category === from);
    if (targets.length === 0) {
      showToast("找不到要重命名的分類", "error");
      return;
    }

    try {
      await Promise.all(targets.map((item) => upsertPriceItemLocal({ ...item, category: to })));
      setItems((prev) => prev.map((item) => (item.category === from ? { ...item, category: to } : item)));
      if (filterCategory === from) {
        setFilterCategory(to);
      }
      setRenameCategoryFrom(to);
      setRenameCategoryTo("");
      setDeleteCategoryName(to);
      showToast(`分類已改名：${from} → ${to}`, "success");
    } catch (renameError) {
      showToast(renameError instanceof Error ? renameError.message : "分類改名失敗", "error");
    }
  }

  async function deleteCategory() {
    const target = deleteCategoryName.trim();
    if (!target) {
      showToast("請選擇要刪除的分類", "error");
      return;
    }
    const count = items.filter((item) => item.category === target).length;
    if (count === 0) {
      showToast("該分類下沒有項目", "error");
      return;
    }
    const ok = window.confirm(`確定刪除分類「${target}」及其 ${count} 個項目？`);
    if (!ok) {
      return;
    }

    try {
      await deletePriceItemsByCategoryLocal(target);
      const nextItems = items.filter((item) => item.category !== target);
      setItems(nextItems);
      if (filterCategory === target) {
        setFilterCategory("");
      }
      if (editingDraft?.category === target) {
        cancelEditItem();
      }
      const nextCategories = Array.from(new Set(nextItems.map((item) => item.category))).filter(Boolean);
      setRenameCategoryFrom(nextCategories[0] ?? "");
      setDeleteCategoryName(nextCategories[0] ?? "");
      setNewItem((prev) => ({
        ...prev,
        category: nextCategories[0] ?? "",
      }));
      showToast(`已刪除分類：${target}`, "success");
    } catch (deleteError) {
      showToast(deleteError instanceof Error ? deleteError.message : "刪除分類失敗", "error");
    }
  }

  async function deleteItem(item: PriceItem) {
    const ok = window.confirm(`確定刪除項目「${item.item_name}」？`);
    if (!ok) {
      return;
    }
    try {
      await deletePriceItemLocal(item.item_id);
      setItems((prev) => prev.filter((row) => row.item_id !== item.item_id));
      if (editingItemId === item.item_id) {
        cancelEditItem();
      }
      showToast(`已刪除項目：${item.item_name}`, "success");
    } catch (deleteError) {
      showToast(deleteError instanceof Error ? deleteError.message : "刪除項目失敗", "error");
    }
  }

  async function createItem() {
    const trimmedName = newItem.item_name.trim();
    const targetCategory = newItem.category.trim();
    if (!trimmedName) {
      showToast("請輸入項目名", "error");
      return;
    }
    if (!targetCategory) {
      showToast("請先建立或選擇分類", "error");
      return;
    }

    const payload: PriceItem = {
      item_id: `custom_${crypto.randomUUID()}`,
      category: targetCategory,
      category_en: newItem.category_en.trim(),
      item_name: trimmedName,
      item_name_en: newItem.item_name_en.trim(),
      original_price: newItem.original_price.trim() || "-",
      share_price: newItem.share_price.trim() || "-",
      notes: newItem.notes.trim(),
      active: newItem.active,
    };

    try {
      await upsertPriceItemLocal(payload);
      setItems((prev) => [...prev, payload]);
      setShowCreateRow(false);
      setNewItem((prev) => ({
        ...EMPTY_NEW_ITEM,
        category: prev.category || targetCategory,
      }));
      showToast(`已新增項目：${payload.item_name}`, "success");
    } catch (createError) {
      showToast(createError instanceof Error ? createError.message : "新增項目失敗", "error");
    }
  }

  function parseActiveValue(value: unknown) {
    const text = String(value ?? "").trim().toLowerCase();
    if (!text) return true;
    return ["1", "true", "yes", "y", "是", "啟用", "开启"].includes(text);
  }

  async function saveStoreProfile() {
    if (!storeProfile) {
      return;
    }
    try {
      const saved = await saveStoreProfileLocal(storeProfile);
      setStoreProfile(saved);
      showToast("店鋪配置已保存", "success");
    } catch (saveError) {
      showToast(saveError instanceof Error ? saveError.message : "店鋪配置保存失敗", "error");
    }
  }

  function updateTier(index: number, patch: Partial<DiscountTier>) {
    setConfigRules((prev) => {
      if (!prev) return prev;
      const next = prev.discountTiers.map((item, i) => (i === index ? { ...item, ...patch } : item));
      return { ...prev, discountTiers: next };
    });
  }

  function addTier() {
    setConfigRules((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        discountTiers: [...prev.discountTiers, { threshold: 1000, rate: 0.95 }],
      };
    });
  }

  function removeTier(index: number) {
    setConfigRules((prev) => {
      if (!prev) return prev;
      if (prev.discountTiers.length <= 1) return prev;
      return {
        ...prev,
        discountTiers: prev.discountTiers.filter((_, i) => i !== index),
      };
    });
  }

  async function saveSystemConfig() {
    if (!configRules) {
      return;
    }
    try {
      const quickAmounts = quickAmountsInput
        .split(/[,\s，；;]+/)
        .map((item) => Number(item.trim()))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.round(value));
      const uniqueQuick = Array.from(new Set(quickAmounts)).sort((a, b) => a - b);
      const nextConfig: ConfigRules = {
        ...configRules,
        discountTiers: normalizeDiscountTiers(configRules.discountTiers),
        topupQuickAmounts: uniqueQuick.length > 0 ? uniqueQuick : configRules.topupQuickAmounts,
      };
      await saveConfigLocal(nextConfig);
      setConfigRules(nextConfig);
      setQuickAmountsInput(nextConfig.topupQuickAmounts.join(","));
      showToast("系統參數已保存", "success");
    } catch (saveError) {
      showToast(saveError instanceof Error ? saveError.message : "系統參數保存失敗", "error");
    }
  }

  async function exportConfigExcel() {
    if (!storeProfile || !configRules) {
      showToast("店鋪配置尚未就緒，請稍後重試", "error");
      return;
    }
    try {
      const workbook = XLSX.utils.book_new();
      const sortedItems = items
        .slice()
        .sort((a, b) => a.category.localeCompare(b.category, "zh-HK"));

      const priceRows: Array<Array<string | number>> = [
        ["item_id", "分類", "分類英文", "項目名", "項目英文", "原價", "分享價", "啟用", "備註"],
        ...sortedItems.map((item) => [
          item.item_id,
          item.category,
          item.category_en?.trim() || "",
          item.item_name,
          item.item_name_en?.trim() || "",
          item.original_price,
          item.share_price,
          item.active ? "是" : "否",
          item.notes || "",
        ]),
      ];
      const priceSheet = XLSX.utils.aoa_to_sheet(priceRows);
      priceSheet["!cols"] = [
        { wch: 22 },
        { wch: 18 },
        { wch: 26 },
        { wch: 26 },
        { wch: 34 },
        { wch: 14 },
        { wch: 14 },
        { wch: 8 },
        { wch: 28 },
      ];
      XLSX.utils.book_append_sheet(workbook, priceSheet, "價目表配置");

      const profileRows: Array<Array<string>> = [
        ["key", "欄位", "value"],
        ["store_name_zh", "店名（中文）", storeProfile.store_name_zh],
        ["store_name_en", "店名（英文）", storeProfile.store_name_en],
        ["address_zh", "地址（中文）", storeProfile.address_zh],
        ["address_en", "地址（英文）", storeProfile.address_en],
        ["parking_zh", "停車（中文）", storeProfile.parking_zh],
        ["parking_en", "停車（英文）", storeProfile.parking_en],
        ["mtr_zh", "地鐵（中文）", storeProfile.mtr_zh],
        ["mtr_en", "地鐵（英文）", storeProfile.mtr_en],
        ["phone", "電話", storeProfile.phone],
        ["blessing_zh", "祝福語（中文）", storeProfile.blessing_zh],
        ["blessing_en", "祝福語（英文）", storeProfile.blessing_en],
      ];
      const profileSheet = XLSX.utils.aoa_to_sheet(profileRows);
      profileSheet["!cols"] = [{ wch: 20 }, { wch: 20 }, { wch: 64 }];
      XLSX.utils.book_append_sheet(workbook, profileSheet, "店鋪配置");

      const sortedTiers = configRules.discountTiers
        .slice()
        .sort((a, b) => b.threshold - a.threshold);
      const configRows: Array<Array<string | number>> = [
        ["key", "欄位", "value"],
        ["currency_code", "記賬貨幣", configRules.currencyCode],
        ["topup_quick_amounts", "快捷充值金額（逗號）", configRules.topupQuickAmounts.join(",")],
        ["rounding_mode", "取整模式", configRules.roundingMode],
        ["rounding_unit", "取整單位", configRules.roundingUnit],
        ["allowed_payment_methods", "付款方式", configRules.allowedPaymentMethods.join(",")],
      ];
      sortedTiers.forEach((tier, index) => {
        configRows.push([`discount_tier_${index + 1}_threshold`, `折扣檔位${index + 1}門檻`, tier.threshold]);
        configRows.push([`discount_tier_${index + 1}_rate`, `折扣檔位${index + 1}折扣率`, tier.rate]);
      });
      const configSheet = XLSX.utils.aoa_to_sheet(configRows);
      configSheet["!cols"] = [{ wch: 28 }, { wch: 24 }, { wch: 28 }];
      XLSX.utils.book_append_sheet(workbook, configSheet, "系統參數");

      XLSX.writeFile(workbook, `價目與店鋪配置_${nowHongKong().bizDate}.xlsx`);
      showToast("已導出價目與店鋪配置 Excel", "success");
    } catch (exportError) {
      showToast(exportError instanceof Error ? exportError.message : "導出失敗", "error");
    }
  }

  async function importConfigExcel(file: File) {
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const priceSheet =
        workbook.Sheets["價目表配置"] ?? workbook.Sheets[workbook.SheetNames[0] ?? ""];
      if (!priceSheet) {
        throw new Error("找不到價目表配置工作表");
      }

      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(priceSheet, {
        defval: "",
      });
      const importedItems: PriceItem[] = rows
        .map((row) => {
          const itemId = String(row.item_id ?? "").trim();
          const category = String(row["分類"] ?? "").trim();
          const categoryEn = String(row["分類英文"] ?? "").trim();
          const itemName = String(row["項目名"] ?? "").trim();
          const itemNameEn = String(row["項目英文"] ?? "").trim();
          if (!itemId || !category || !itemName) {
            return null;
          }
          return normalizePriceItemForSave({
            item_id: itemId,
            category,
            category_en: categoryEn,
            item_name: itemName,
            item_name_en: itemNameEn,
            original_price: String(row["原價"] ?? "-").trim() || "-",
            share_price: String(row["分享價"] ?? "-").trim() || "-",
            active: parseActiveValue(row["啟用"]),
            notes: String(row["備註"] ?? "").trim(),
          });
        })
        .filter((item): item is PriceItem => Boolean(item));

      if (importedItems.length === 0) {
        throw new Error("導入內容為空，請檢查 Excel");
      }

      const profileSheet = workbook.Sheets["店鋪配置"];
      let profilePatch: Partial<StoreProfile> = {};
      const profileKeys: Array<keyof StoreProfile> = [
        "store_name_zh",
        "store_name_en",
        "address_zh",
        "address_en",
        "parking_zh",
        "parking_en",
        "mtr_zh",
        "mtr_en",
        "phone",
        "blessing_zh",
        "blessing_en",
      ];
      if (profileSheet) {
        const profileRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(profileSheet, {
          defval: "",
        });
        profileRows.forEach((row) => {
          const key = String(row.key ?? "").trim();
          const value = String(row.value ?? "").trim();
          if (!key || !profileKeys.includes(key as keyof StoreProfile)) return;
          profilePatch = { ...profilePatch, [key as keyof StoreProfile]: value };
        });
      }

      const configSheet = workbook.Sheets["系統參數"];
      let importedConfig: ConfigRules | null = null;
      if (configSheet && configRules) {
        const configRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(configSheet, {
          defval: "",
        });
        const map = new Map<string, string>();
        configRows.forEach((row) => {
          const key = String(row.key ?? "").trim();
          const value = String(row.value ?? "").trim();
          if (key) {
            map.set(key, value);
          }
        });

        const tierKeys = Array.from(map.keys())
          .filter((key) => key.startsWith("discount_tier_") && key.endsWith("_threshold"))
          .sort((a, b) => a.localeCompare(b, "zh-HK"));
        const tiers: DiscountTier[] = tierKeys
          .map((thresholdKey) => {
            const prefix = thresholdKey.replace("_threshold", "");
            const rateKey = `${prefix}_rate`;
            const threshold = Number(map.get(thresholdKey) ?? "");
            const rate = Number(map.get(rateKey) ?? "");
            if (
              !Number.isFinite(threshold) ||
              threshold <= 0 ||
              !Number.isFinite(rate) ||
              rate <= 0 ||
              rate > 1
            ) {
              return null;
            }
            return { threshold, rate };
          })
          .filter((item): item is DiscountTier => Boolean(item));

        const quickAmounts = (map.get("topup_quick_amounts") ?? "")
          .split(/[,\s，；;]+/)
          .map((item) => Number(item.trim()))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.round(value));

        importedConfig = {
          ...configRules,
          currencyCode: (map.get("currency_code")?.toUpperCase() as ConfigRules["currencyCode"]) || configRules.currencyCode,
          topupQuickAmounts:
            quickAmounts.length > 0 ? Array.from(new Set(quickAmounts)).sort((a, b) => a - b) : configRules.topupQuickAmounts,
          discountTiers: normalizeDiscountTiers(tiers.length > 0 ? tiers : configRules.discountTiers),
          roundingMode: (map.get("rounding_mode")?.toUpperCase() as ConfigRules["roundingMode"]) || configRules.roundingMode,
          roundingUnit:
            Number(map.get("rounding_unit") ?? "") > 0
              ? Number(map.get("rounding_unit"))
              : configRules.roundingUnit,
          allowedPaymentMethods: ["BALANCE"],
        };
      }

      await replacePriceListLocal(importedItems);
      if (Object.keys(profilePatch).length > 0) {
        const saved = await saveStoreProfileLocal(profilePatch);
        setStoreProfile(saved);
      }
      if (importedConfig) {
        await saveConfigLocal(importedConfig);
        setConfigRules(importedConfig);
        setQuickAmountsInput(importedConfig.topupQuickAmounts.join(","));
      }
      await loadPriceList();
      showToast("已按 Excel 全量覆蓋價目與店鋪配置", "success");
    } catch (importError) {
      showToast(importError instanceof Error ? importError.message : "導入失敗", "error");
    }
  }

  if (loading) {
    return <div className="rounded-2xl bg-white p-4">加載中...</div>;
  }

  if (error && items.length === 0) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-700">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold text-slate-900">價目表</h2>
          <select
            value={filterCategory}
            onChange={(event) => setFilterCategory(event.target.value)}
            className="h-10 rounded-lg border border-slate-200 px-3"
          >
            <option value="">全部分類</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          本地價目表可直接修改，保存後即時生效。分類可在下方新增/改名/刪除。英文欄位留空時，系統會自動回退中文。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={exportConfigExcel}
            className="h-10 rounded-lg bg-slate-800 px-4 text-sm font-semibold text-white"
          >
            導出價目與店鋪配置 Excel
          </button>
          <button
            type="button"
            onClick={() => {
              const ok = window.confirm("將按 Excel 全量覆蓋價目與店鋪配置，確定導入？");
              if (!ok) return;
              importInputRef.current?.click();
            }}
            className="h-10 rounded-lg border border-cyan-400 bg-cyan-50 px-4 text-sm font-semibold text-cyan-700"
          >
            導入覆蓋 Excel（全量）
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void importConfigExcel(file);
              }
              event.currentTarget.value = "";
            }}
          />
        </div>
      </section>

      {storeProfile && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h3 className="text-base font-bold text-slate-900">店鋪配置（郵件與英文顯示）</h3>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <input
              value={storeProfile.store_name_zh}
              onChange={(event) =>
                setStoreProfile((prev) => (prev ? { ...prev, store_name_zh: event.target.value } : prev))
              }
              placeholder="店名（中文）"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={storeProfile.store_name_en}
              onChange={(event) =>
                setStoreProfile((prev) => (prev ? { ...prev, store_name_en: event.target.value } : prev))
              }
              placeholder="店名（英文）"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={storeProfile.address_zh}
              onChange={(event) =>
                setStoreProfile((prev) => (prev ? { ...prev, address_zh: event.target.value } : prev))
              }
              placeholder="地址（中文）"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={storeProfile.address_en}
              onChange={(event) =>
                setStoreProfile((prev) => (prev ? { ...prev, address_en: event.target.value } : prev))
              }
              placeholder="地址（英文）"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={storeProfile.parking_zh}
              onChange={(event) =>
                setStoreProfile((prev) => (prev ? { ...prev, parking_zh: event.target.value } : prev))
              }
              placeholder="停車（中文）"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={storeProfile.parking_en}
              onChange={(event) =>
                setStoreProfile((prev) => (prev ? { ...prev, parking_en: event.target.value } : prev))
              }
              placeholder="停車（英文）"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={storeProfile.mtr_zh}
              onChange={(event) =>
                setStoreProfile((prev) => (prev ? { ...prev, mtr_zh: event.target.value } : prev))
              }
              placeholder="地鐵（中文）"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={storeProfile.mtr_en}
              onChange={(event) =>
                setStoreProfile((prev) => (prev ? { ...prev, mtr_en: event.target.value } : prev))
              }
              placeholder="地鐵（英文）"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={storeProfile.phone}
              onChange={(event) =>
                setStoreProfile((prev) => (prev ? { ...prev, phone: event.target.value } : prev))
              }
              placeholder="電話"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <div />
            <input
              value={storeProfile.blessing_zh}
              onChange={(event) =>
                setStoreProfile((prev) => (prev ? { ...prev, blessing_zh: event.target.value } : prev))
              }
              placeholder="祝福語（中文）"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={storeProfile.blessing_en}
              onChange={(event) =>
                setStoreProfile((prev) => (prev ? { ...prev, blessing_en: event.target.value } : prev))
              }
              placeholder="祝福語（英文）"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              void saveStoreProfile();
            }}
            className="mt-3 h-10 rounded-lg bg-cyan-700 px-4 text-sm font-semibold text-white"
          >
            保存店鋪配置
          </button>
        </section>
      )}

      {configRules && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h3 className="text-base font-bold text-slate-900">系統參數（折扣/貨幣）</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-sm text-slate-700">
              記賬貨幣
              <select
                value={configRules.currencyCode}
                onChange={(event) =>
                  setConfigRules((prev) =>
                    prev ? { ...prev, currencyCode: event.target.value as ConfigRules["currencyCode"] } : prev,
                  )
                }
                className="mt-1 h-10 w-full rounded-lg border border-slate-200 px-3"
              >
                {CURRENCY_OPTIONS.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-slate-700">
              快捷充值金額（逗號分隔）
              <input
                value={quickAmountsInput}
                onChange={(event) => setQuickAmountsInput(event.target.value)}
                placeholder="例如：500,1000,2000,5000"
                className="mt-1 h-10 w-full rounded-lg border border-slate-200 px-3"
              />
            </label>
          </div>
          <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-800">充值折扣檔位</p>
              <button
                type="button"
                onClick={addTier}
                className="h-8 rounded-lg border border-cyan-300 bg-white px-3 text-xs font-semibold text-cyan-700"
              >
                + 新增檔位
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {configRules.discountTiers.map((tier, index) => (
                <div key={`${tier.threshold}-${index}`} className="grid gap-2 md:grid-cols-[1fr_1fr_auto_auto]">
                  <input
                    type="number"
                    min={1}
                    value={tier.threshold}
                    onChange={(event) => updateTier(index, { threshold: Number(event.target.value || "0") })}
                    placeholder="門檻金額"
                    className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
                  />
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={Number((tier.rate * 100).toFixed(2))}
                    onChange={(event) =>
                      updateTier(index, { rate: Number(event.target.value || "100") / 100 })
                    }
                    placeholder="折扣百分比"
                    className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
                  />
                  <div className="flex items-center px-2 text-xs font-semibold text-slate-600">
                    {formatTierLabel(tier.rate)}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeTier(index)}
                    className="h-9 rounded-lg border border-rose-300 bg-white px-3 text-xs font-semibold text-rose-700"
                  >
                    刪除
                  </button>
                </div>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void saveSystemConfig();
            }}
            className="mt-3 h-10 rounded-lg bg-cyan-700 px-4 text-sm font-semibold text-white"
          >
            保存系統參數
          </button>
        </section>
      )}

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="grid gap-2 lg:grid-cols-[1fr_1fr_auto]">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2 py-2">
            <span className="text-xs font-semibold text-slate-600">新增分類</span>
            <input
              value={newCategoryName}
              onChange={(event) => setNewCategoryName(event.target.value)}
              placeholder="新分類名稱"
              className="h-9 min-w-[140px] flex-1 rounded-lg border border-slate-200 bg-white px-2 text-sm"
            />
            <button
              type="button"
              onClick={addCategory}
              className="h-9 rounded-lg bg-cyan-700 px-3 text-sm font-semibold text-white"
            >
              新增
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2 py-2">
            <span className="text-xs font-semibold text-slate-600">分類改名</span>
            <select
              value={renameCategoryFrom}
              onChange={(event) => setRenameCategoryFrom(event.target.value)}
              className="h-9 min-w-[140px] rounded-lg border border-slate-200 bg-white px-2 text-sm"
            >
              <option value="">舊分類</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
            <input
              value={renameCategoryTo}
              onChange={(event) => setRenameCategoryTo(event.target.value)}
              placeholder="新名稱"
              className="h-9 min-w-[120px] flex-1 rounded-lg border border-slate-200 bg-white px-2 text-sm"
            />
            <button
              type="button"
              onClick={renameCategory}
              className="h-9 rounded-lg bg-slate-800 px-3 text-sm font-semibold text-white"
            >
              改名
            </button>
          </div>

          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2 py-2">
            <select
              value={deleteCategoryName}
              onChange={(event) => setDeleteCategoryName(event.target.value)}
              className="h-9 min-w-[150px] rounded-lg border border-slate-200 bg-white px-2 text-sm"
            >
              <option value="">選擇分類</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={deleteCategory}
              className="h-9 rounded-lg border border-rose-300 bg-white px-3 text-sm font-semibold text-rose-700"
            >
              刪除分類
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-2 shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-[1320px] w-full table-fixed text-sm">
            <thead className="sticky top-0 bg-slate-50 text-slate-600">
              <tr>
                <th className="w-[14%] px-2 py-2 text-left font-semibold">項目名</th>
                <th className="w-[14%] px-2 py-2 text-left font-semibold">項目英文</th>
                <th className="w-[14%] px-2 py-2 text-left font-semibold">分類</th>
                <th className="w-[14%] px-2 py-2 text-left font-semibold">分類英文</th>
                <th className="w-[10%] px-2 py-2 text-left font-semibold">原價</th>
                <th className="w-[10%] px-2 py-2 text-left font-semibold">分享價</th>
                <th className="w-[14%] px-2 py-2 text-left font-semibold">備註</th>
                <th className="w-[6%] px-2 py-2 text-center font-semibold">啟用</th>
                <th className="w-[160px] px-2 py-2 text-left font-semibold">操作</th>
              </tr>
            </thead>
            <tbody>
              {showCreateRow && (
                <tr className="border-t border-slate-200 bg-cyan-50/40">
                  <td className="px-2 py-1.5">
                    <input
                      value={newItem.item_name}
                      onChange={(event) =>
                        setNewItem((prev) => ({ ...prev, item_name: event.target.value }))
                      }
                      placeholder="新項目名"
                      className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={newItem.item_name_en}
                      onChange={(event) =>
                        setNewItem((prev) => ({ ...prev, item_name_en: event.target.value }))
                      }
                      placeholder="項目英文（可空）"
                      className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      value={newItem.category}
                      onChange={(event) =>
                        setNewItem((prev) => ({ ...prev, category: event.target.value }))
                      }
                      className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2"
                    >
                      <option value="">選擇分類</option>
                      {categories.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={newItem.category_en}
                      onChange={(event) =>
                        setNewItem((prev) => ({ ...prev, category_en: event.target.value }))
                      }
                      placeholder="分類英文（可空）"
                      className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={newItem.original_price}
                      onChange={(event) =>
                        setNewItem((prev) => ({ ...prev, original_price: event.target.value }))
                      }
                      placeholder="原價"
                      className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={newItem.share_price}
                      onChange={(event) =>
                        setNewItem((prev) => ({ ...prev, share_price: event.target.value }))
                      }
                      placeholder="分享價"
                      className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={newItem.notes}
                      onChange={(event) => setNewItem((prev) => ({ ...prev, notes: event.target.value }))}
                      placeholder="備註"
                      className="h-8 w-full rounded-lg border border-slate-200 bg-white px-2"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={newItem.active}
                      onChange={(event) =>
                        setNewItem((prev) => ({ ...prev, active: event.target.checked }))
                      }
                    />
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <div className="flex flex-nowrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={createItem}
                        className="inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg bg-cyan-700 px-2.5 text-xs font-semibold leading-none text-white"
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowCreateRow(false);
                          setNewItem((prev) => ({ ...EMPTY_NEW_ITEM, category: prev.category }));
                        }}
                        className="inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold leading-none text-slate-600"
                      >
                        取消
                      </button>
                    </div>
                  </td>
                </tr>
              )}

              {filtered.map((item) => {
                const isEditing = editingItemId === item.item_id && editingDraft?.item_id === item.item_id;
                const row = isEditing && editingDraft ? editingDraft : item;
                return (
                  <tr key={item.item_id} className="border-t border-slate-100">
                    <td className="px-2 py-1.5">
                      {isEditing ? (
                        <input
                          value={row.item_name}
                          onChange={(event) =>
                            setEditingDraft((prev) => (prev ? { ...prev, item_name: event.target.value } : prev))
                          }
                          className="h-8 w-full rounded-lg border border-slate-200 px-2"
                        />
                      ) : (
                        <p className="truncate text-slate-900">{item.item_name}</p>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {isEditing ? (
                        <input
                          value={row.item_name_en || ""}
                          onChange={(event) =>
                            setEditingDraft((prev) =>
                              prev ? { ...prev, item_name_en: event.target.value } : prev,
                            )
                          }
                          className="h-8 w-full rounded-lg border border-slate-200 px-2"
                        />
                      ) : (
                        <p className="truncate text-slate-700">
                          {item.item_name_en?.trim() || "（空）"}
                        </p>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {isEditing ? (
                        <select
                          value={row.category}
                          onChange={(event) =>
                            setEditingDraft((prev) => (prev ? { ...prev, category: event.target.value } : prev))
                          }
                          className="h-8 w-full rounded-lg border border-slate-200 px-2"
                        >
                          {categories.map((category) => (
                            <option key={category} value={category}>
                              {category}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="truncate text-slate-700">{item.category}</p>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {isEditing ? (
                        <input
                          value={row.category_en || ""}
                          onChange={(event) =>
                            setEditingDraft((prev) =>
                              prev ? { ...prev, category_en: event.target.value } : prev,
                            )
                          }
                          className="h-8 w-full rounded-lg border border-slate-200 px-2"
                        />
                      ) : (
                        <p className="truncate text-slate-700">
                          {item.category_en?.trim() || "（空）"}
                        </p>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {isEditing ? (
                        <input
                          value={row.original_price}
                          onChange={(event) =>
                            setEditingDraft((prev) =>
                              prev ? { ...prev, original_price: event.target.value } : prev,
                            )
                          }
                          className="h-8 w-full rounded-lg border border-slate-200 px-2"
                        />
                      ) : (
                        <p className="truncate text-slate-700">{item.original_price || "-"}</p>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {isEditing ? (
                        <input
                          value={row.share_price}
                          onChange={(event) =>
                            setEditingDraft((prev) =>
                              prev ? { ...prev, share_price: event.target.value } : prev,
                            )
                          }
                          className="h-8 w-full rounded-lg border border-slate-200 px-2"
                        />
                      ) : (
                        <p className="truncate text-slate-700">{item.share_price || "-"}</p>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {isEditing ? (
                        <input
                          value={row.notes}
                          onChange={(event) =>
                            setEditingDraft((prev) => (prev ? { ...prev, notes: event.target.value } : prev))
                          }
                          className="h-8 w-full rounded-lg border border-slate-200 px-2"
                        />
                      ) : (
                        <p className="truncate text-slate-700">{item.notes || "-"}</p>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {isEditing ? (
                        <input
                          type="checkbox"
                          checked={row.active}
                          onChange={(event) =>
                            setEditingDraft((prev) => (prev ? { ...prev, active: event.target.checked } : prev))
                          }
                        />
                      ) : (
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-semibold ${
                            item.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"
                          }`}
                        >
                          {item.active ? "是" : "否"}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <div className="flex flex-nowrap items-center gap-1.5">
                        {isEditing ? (
                          <>
                            <button
                              type="button"
                              onClick={saveEditingItem}
                              className="inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg bg-cyan-700 px-2.5 text-xs font-semibold leading-none text-white"
                            >
                              保存
                            </button>
                            <button
                              type="button"
                              onClick={cancelEditItem}
                              className="inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold leading-none text-slate-600"
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => startEditItem(item)}
                              className="inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-semibold leading-none text-slate-700"
                            >
                              編輯
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteItem(item)}
                              className="inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-rose-300 bg-white px-2.5 text-xs font-semibold leading-none text-rose-700"
                            >
                              刪除
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-2 border-t border-slate-100 pt-2">
          <button
            type="button"
            onClick={() => setShowCreateRow((prev) => !prev)}
            className="h-9 rounded-lg border border-dashed border-cyan-400 bg-cyan-50 px-3 text-sm font-semibold text-cyan-700"
          >
            {showCreateRow ? "收起新增項目" : "+ 新增項目"}
          </button>
        </div>
      </section>

      {(message || error) && (
        <div className="fixed bottom-4 right-4 z-40">
          <div
            className={`rounded-xl px-4 py-3 text-sm font-semibold shadow-lg ${
              error ? "bg-rose-600 text-white" : "bg-emerald-600 text-white"
            }`}
          >
            {error || message}
          </div>
        </div>
      )}
    </div>
  );
}
