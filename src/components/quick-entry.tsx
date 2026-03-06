"use client";

import {
  getConfigLocal,
  getMemberByIdLocal,
  getPriceListLocal,
  getStoreProfileLocal,
  getTransactionsLocal,
  searchMembersLocal,
  upsertMemberLocal,
} from "@/lib/local-db";
import { executeCheckoutLocal } from "@/lib/local-transactions";
import {
  type ItemDisplayLanguage,
} from "@/lib/pricelist-i18n";
import {
  computeOrderAmounts,
  getDiscountRateByTopupAmount,
  getLockedDiscountRateFromTransactions,
  parseConfiguredPrice,
  resolveLinePrice,
  settlePayableWithExtraDiscount,
} from "@/lib/pricing";
import { formatCurrency, nowHongKong } from "@/lib/time";
import type { ConfigRules, Member, PriceItem, StoreProfile, TransactionRecord } from "@/lib/types";
import { useEffect, useMemo, useRef, useState } from "react";

interface CheckoutPreview {
  gross: number;
  memberDeductBeforeAdjust: number;
  externalPayBeforeAdjust: number;
  payableBeforeAdjust: number;
  memberDeduct: number;
  externalPay: number;
  extraDiscountApplied: number;
  floorDiscountApplied: number;
  hasFloorDiscount: boolean;
  totalPayable: number;
  memberSavings: number;
  discountRate: number;
  balanceBefore: number;
  balanceAfter: number;
  settlementMode: "FULL_BALANCE" | "PARTIAL_BALANCE" | "WALKIN_ORIGINAL";
  lines: Array<{
    item_id: string;
    category: string;
    item_name: string;
    quantity: number;
    unitPrice: number;
    gross: number;
    memberDeduct: number;
    externalPay: number;
    lineTotal: number;
    saved: number;
  }>;
}

interface SelectedItem {
  item_id: string;
  quantity: number;
  manual_unit_price?: number;
  price_choice?: "SHARE" | "ORIGINAL" | "MANUAL";
}

function detectDevice(): "iPad" | "Phone" {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("ipad") || ua.includes("tablet")) {
    return "iPad";
  }
  return "Phone";
}

function parseFirstPrice(raw: string | null | undefined) {
  const text = (raw ?? "").replace(/,/g, "");
  const match = text.match(/\d+(\.\d+)?/);
  if (!match) {
    return null;
  }
  const value = Number(match[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parsePriceCandidates(raw: string | null | undefined) {
  const text = (raw ?? "").replace(/,/g, "");
  const matches = text.match(/\d+(\.\d+)?/g) ?? [];
  const result: number[] = [];
  const seen = new Set<number>();
  matches.forEach((token) => {
    const value = Number(token);
    if (!Number.isFinite(value) || value <= 0 || seen.has(value)) {
      return;
    }
    seen.add(value);
    result.push(value);
  });
  return result;
}

function hasDisplayAmount(value: number) {
  return Number.isFinite(value) && Math.abs(value) >= 0.005;
}

function formatAmountOrDash(value: number) {
  return hasDisplayAmount(value) ? formatCurrency(value) : "—";
}

interface ReceiptMailLineItem {
  item_id?: string;
  item_name: string;
  item_name_en?: string;
  category: string;
  category_en?: string;
  quantity: number;
  unit_price: number;
  line_amount: number;
}

interface ReceiptMailPayload {
  lang?: "zh" | "en";
  to_email: string;
  member_name: string;
  biz_date: string;
  biz_time: string;
  gross_amount: number;
  member_deduct_amount: number;
  external_pay_amount: number;
  extra_discount_amount: number;
  floor_discount_amount: number;
  total_payable_amount: number;
  discount_rate: number;
  balance_before_topup: number;
  topup_amount: number;
  balance_before_deduct: number;
  balance_after: number;
  store_profile?: Partial<StoreProfile>;
  notes?: string;
  items: ReceiptMailLineItem[];
}

interface CheckoutSummary {
  isMember: boolean;
  memberName: string;
  bizDate: string;
  bizTime: string;
  discountRate: number;
  grossAmount: number;
  memberDeductAmount: number;
  externalPayAmount: number;
  extraDiscountAmount: number;
  floorDiscountAmount: number;
  totalPayableAmount: number;
  memberSavingsAmount: number;
  balanceBeforeTopup: number;
  topupAmount: number;
  balanceBeforeDeduct: number;
  balanceAfter: number;
  notes?: string;
  items: ReceiptMailLineItem[];
}

type SubmitStage = "IDLE" | "SAVING" | "MAILING";
type MailStatus = "IDLE" | "SKIPPED" | "SENT" | "FAILED";

async function sendReceiptMail(payload: ReceiptMailPayload) {
  const response = await fetch("/api/notify/member-receipt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("會員郵件發送失敗");
  }
}

async function sendReceiptMailWithRetry(payload: ReceiptMailPayload, maxRetries = 3) {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await sendReceiptMail(payload);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("會員郵件發送失敗");
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw lastError ?? new Error("會員郵件發送失敗");
}

export default function QuickEntry() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [config, setConfig] = useState<ConfigRules | null>(null);
  const [priceList, setPriceList] = useState<PriceItem[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [settlementLanguage, setSettlementLanguage] = useState<ItemDisplayLanguage>("zh");
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [storeProfile, setStoreProfile] = useState<StoreProfile | null>(null);

  const [memberKeyword, setMemberKeyword] = useState("");
  const [memberResults, setMemberResults] = useState<Member[]>([]);
  const [memberLoading, setMemberLoading] = useState(false);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [walkInGender, setWalkInGender] = useState<"" | "女" | "男">("");

  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([]);
  const [manualPriceDraftMap, setManualPriceDraftMap] = useState<Record<string, string>>({});
  const manualPriceInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [topupAmount, setTopupAmount] = useState<number>(0);
  const [extraDiscountAmount, setExtraDiscountAmount] = useState<number>(0);
  const [applyFloorDiscount, setApplyFloorDiscount] = useState<boolean>(false);
  const [showTopupPanel, setShowTopupPanel] = useState(false);
  const [showManualDiscountPanel, setShowManualDiscountPanel] = useState(false);
  const [notes, setNotes] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitResult, setSubmitResult] = useState<string>("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [flashItemId, setFlashItemId] = useState<string | null>(null);
  const [submitStage, setSubmitStage] = useState<SubmitStage>("IDLE");
  const [mailStatus, setMailStatus] = useState<MailStatus>("IDLE");
  const [mailStatusText, setMailStatusText] = useState("");
  const [lastMailPayload, setLastMailPayload] = useState<ReceiptMailPayload | null>(null);
  const [lastSummary, setLastSummary] = useState<CheckoutSummary | null>(null);
  const [updatingTier, setUpdatingTier] = useState(false);
  const [tierUpdateMessage, setTierUpdateMessage] = useState("");

  async function loadBaseData() {
    const [localConfig, localPriceList, localTransactions, localStoreProfile] = await Promise.all([
      getConfigLocal(),
      getPriceListLocal(),
      getTransactionsLocal(),
      getStoreProfileLocal(),
    ]);
    const activeItems = localPriceList.filter((item) => item.active);
    const localCategories = Array.from(new Set(activeItems.map((item) => item.category))).filter(Boolean);

    setConfig(localConfig);
    setPriceList(activeItems);
    setCategories(localCategories);
    setActiveCategory(localCategories[0] ?? "");
    setTransactions(localTransactions);
    setStoreProfile(localStoreProfile);
  }

  useEffect(() => {
    let mounted = true;
    loadBaseData()
      .catch((fetchError: Error) => {
        if (!mounted) {
          return;
        }
        setError(fetchError.message);
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const priceMap = useMemo(
    () => new Map(priceList.map((item) => [item.item_id, item])),
    [priceList],
  );

  const isSettlementEnglish = settlementLanguage === "en";
  const t = (zh: string, en: string) => (isSettlementEnglish ? en : zh);

  function displayCategory(
    category: string,
    language: ItemDisplayLanguage = "zh",
    itemId?: string,
  ) {
    if (language === "zh") {
      return category || "未分類";
    }
    const item = itemId ? priceMap.get(itemId) : null;
    const customEn = item?.category_en?.trim() ?? "";
    if (customEn) {
      return customEn;
    }
    return category || "未分類";
  }

  function displayItemName(
    itemName: string,
    itemId?: string,
    language: ItemDisplayLanguage = "zh",
  ) {
    if (language === "zh") {
      return itemName;
    }
    const item = itemId ? priceMap.get(itemId) : null;
    const customEn = item?.item_name_en?.trim() ?? "";
    if (customEn) {
      return customEn;
    }
    return itemName;
  }

  function getPriceChoiceMeta(item: PriceItem) {
    const share = parseConfiguredPrice(item.share_price);
    const original = parseConfiguredPrice(item.original_price);
    const shareRaw = (item.share_price ?? "").trim();
    const originalRaw = (item.original_price ?? "").trim();
    const shareRawLower = shareRaw.toLowerCase();
    const shareMissing =
      !shareRawLower ||
      shareRawLower === "-" ||
      shareRawLower === "--" ||
      shareRawLower === "000" ||
      shareRawLower === "0";

    const shareCandidates = parsePriceCandidates(item.share_price);
    const originalCandidates = parsePriceCandidates(item.original_price);
    const hasShareRange = /[\/／]/.test(shareRaw);
    const hasOriginalRange = /[\/／]/.test(originalRaw);
    const hasRange = hasShareRange || hasOriginalRange;

    const sharePreset = share.isValidNumber ? share.amount : (shareCandidates[0] ?? parseFirstPrice(item.share_price));
    const originalPreset =
      original.isValidNumber ? original.amount : (originalCandidates[0] ?? parseFirstPrice(item.original_price));

    let rangePreset: number | null = null;
    let rangeSource: "SHARE" | "ORIGINAL" | null = null;
    const shareSecond = shareCandidates[1] ?? null;
    const originalSecond = originalCandidates[1] ?? null;
    if (shareSecond && shareSecond !== sharePreset) {
      rangePreset = shareSecond;
      rangeSource = "SHARE";
    } else if (originalSecond && originalSecond !== originalPreset) {
      rangePreset = originalSecond;
      rangeSource = "ORIGINAL";
    }

    const hasShareOption = !shareMissing && !!sharePreset;
    const hasOriginalOption = !!originalPreset;
    const hasDifferentPresets =
      hasShareOption && hasOriginalOption && sharePreset !== originalPreset;
    const requiresChoice =
      hasRange || hasDifferentPresets || !hasShareOption || !hasOriginalOption;

    return {
      requiresChoice,
      sharePreset,
      originalPreset,
      shareMissing,
      hasRange,
      rangePreset,
      rangeSource,
    };
  }

  const preview = useMemo<CheckoutPreview | null>(() => {
    if (!config || selectedItems.length === 0) {
      return null;
    }

    try {
      const lines = selectedItems.map((selected) => {
        const item = priceMap.get(selected.item_id);
        if (!item) {
          throw new Error("項目不存在");
        }
        const preferredSource =
          selected.price_choice === "SHARE"
            ? "share"
            : selected.price_choice === "ORIGINAL"
              ? "original"
              : selected.price_choice === "MANUAL"
                ? "manual"
                : undefined;
        const resolved = resolveLinePrice(item, selected.manual_unit_price, preferredSource);
        return {
          item_id: item.item_id,
          category: item.category,
          item_name: item.item_name,
          quantity: selected.quantity,
          unitPrice: resolved.unitPrice,
          line_amount: resolved.unitPrice * selected.quantity,
          unit_source: resolved.unitSource,
        };
      });
      const balanceBefore = selectedMember ? selectedMember.balance + topupAmount : 0;
      const discountRate = selectedMember
        ? getLockedDiscountRateFromTransactions(
            selectedMember.member_id,
            selectedMember.balance,
            transactions,
            config.discountTiers,
            topupAmount,
            selectedMember.manual_locked_discount_rate,
          )
        : 1;
      const lineRows = lines.map((line) => ({
        item_id: "",
        item_name: "",
        category: "",
        quantity: 1,
        unit_source: line.unit_source,
        unit_price: line.line_amount,
        line_amount: line.line_amount,
        manual_input: line.unit_source === "manual",
      }));
      const { grossAmount, netAmount } = computeOrderAmounts(lineRows, discountRate);
      let memberDeduct = selectedMember ? netAmount : 0;
      let externalPay = selectedMember ? 0 : netAmount;
      let settlementMode: CheckoutPreview["settlementMode"] = selectedMember
        ? "FULL_BALANCE"
        : "WALKIN_ORIGINAL";
      if (selectedMember && balanceBefore < netAmount) {
        const safeRate = discountRate > 0 ? discountRate : 1;
        const grossCoveredByBalance = balanceBefore / safeRate;
        const remainingGross = Math.max(grossAmount - grossCoveredByBalance, 0);
        memberDeduct = balanceBefore;
        externalPay = remainingGross;
        settlementMode = "PARTIAL_BALANCE";
      }
      const memberDeductBeforeAdjust = memberDeduct;
      const externalPayBeforeAdjust = externalPay;
      const payableBeforeAdjust = memberDeductBeforeAdjust + externalPayBeforeAdjust;
      const settled = settlePayableWithExtraDiscount({
        memberDeductAmount: memberDeduct,
        externalPayAmount: externalPay,
        extraDiscountAmount,
        applyFloorDiscount: selectedMember ? applyFloorDiscount : true,
      });
      memberDeduct = settled.memberDeductAmount;
      externalPay = settled.externalPayAmount;
      const safeRate = discountRate > 0 ? discountRate : 1;
      let coveredGrossRemaining = selectedMember
        ? Math.min(grossAmount, memberDeductBeforeAdjust / safeRate)
        : 0;
      const lineBreakdown = lines.map((line) => {
        const gross = line.line_amount;
        let coveredGross = 0;
        if (selectedMember) {
          coveredGross = Math.min(gross, coveredGrossRemaining);
          coveredGrossRemaining = Math.max(coveredGrossRemaining - coveredGross, 0);
        }
        const uncoveredGross = selectedMember ? Math.max(gross - coveredGross, 0) : gross;
        const rawMemberDeduct = selectedMember ? coveredGross * discountRate : 0;
        const rawExternalPay = selectedMember ? uncoveredGross : gross;
        return {
          item_id: line.item_id,
          category: line.category,
          item_name: line.item_name,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          gross,
          memberDeduct: rawMemberDeduct,
          externalPay: rawExternalPay,
          lineTotal: rawMemberDeduct + rawExternalPay,
          saved: selectedMember ? Math.max(coveredGross - rawMemberDeduct, 0) : 0,
        };
      });
      const lineCount = lineBreakdown.length;
      if (lineCount > 0 && selectedMember) {
        const memberDelta =
          memberDeductBeforeAdjust - lineBreakdown.reduce((sum, line) => sum + line.memberDeduct, 0);
        const externalDelta =
          externalPayBeforeAdjust - lineBreakdown.reduce((sum, line) => sum + line.externalPay, 0);
        lineBreakdown[lineCount - 1].memberDeduct += memberDelta;
        lineBreakdown[lineCount - 1].externalPay += externalDelta;
        lineBreakdown[lineCount - 1].lineTotal += memberDelta + externalDelta;
        lineBreakdown[lineCount - 1].saved = Math.max(
          lineBreakdown[lineCount - 1].gross -
            lineBreakdown[lineCount - 1].memberDeduct -
            lineBreakdown[lineCount - 1].externalPay,
          0,
        );
      }
      const totalPayable = settled.totalPayableAmount;
      const memberSavings = selectedMember ? Math.max(grossAmount - totalPayable, 0) : 0;
      return {
        gross: grossAmount,
        memberDeductBeforeAdjust,
        externalPayBeforeAdjust,
        payableBeforeAdjust,
        memberDeduct,
        externalPay,
        extraDiscountApplied: settled.extraDiscountApplied,
        floorDiscountApplied: settled.floorDiscountApplied,
        hasFloorDiscount: settled.hasFloorDiscount,
        totalPayable,
        memberSavings,
        discountRate,
        balanceBefore,
        balanceAfter: selectedMember ? Math.max(balanceBefore - memberDeduct, 0) : 0,
        settlementMode,
        lines: lineBreakdown,
      };
    } catch {
      return null;
    }
  }, [selectedMember, config, selectedItems, priceMap, topupAmount, extraDiscountAmount, applyFloorDiscount, transactions]);

  const categoryItems = useMemo(
    () => priceList.filter((item) => item.category === activeCategory),
    [priceList, activeCategory],
  );

  const todayBizDate = useMemo(() => nowHongKong().bizDate, []);
  const selectedMemberDiscountRate = useMemo(() => {
    if (!selectedMember || !config) {
      return 1;
    }
    return getLockedDiscountRateFromTransactions(
      selectedMember.member_id,
      selectedMember.balance,
      transactions,
      config.discountTiers,
      0,
      selectedMember.manual_locked_discount_rate,
    );
  }, [selectedMember, config, transactions]);

  const quickTopupOptions = useMemo(() => {
    const options = config?.topupQuickAmounts ?? [1500, 3000, 5000, 10000];
    return options.slice().sort((a, b) => a - b);
  }, [config]);

  const discountTierText = useMemo(() => {
    if (!config || config.discountTiers.length === 0) {
      return isSettlementEnglish ? "No discount tiers configured." : "未配置折扣檔位。";
    }
    const rows = config.discountTiers
      .slice()
      .sort((a, b) => a.threshold - b.threshold)
      .map((tier) => {
        const discountText = (tier.rate * 10).toFixed(tier.rate * 10 % 1 === 0 ? 0 : 1);
        return isSettlementEnglish
          ? `>=${tier.threshold} (${discountText} off)`
          : `>=${tier.threshold}（${discountText}折）`;
      });
    return rows.join(" / ");
  }, [config, isSettlementEnglish]);

  const manualTierOptions = useMemo(() => {
    const rates = new Set<number>();
    (config?.discountTiers ?? []).forEach((tier) => {
      if (Number.isFinite(tier.rate) && tier.rate > 0 && tier.rate <= 1) {
        rates.add(tier.rate);
      }
    });
    rates.add(1);
    return Array.from(rates).sort((a, b) => a - b);
  }, [config]);

  const selectedCountMap = useMemo(() => {
    const map = new Map<string, number>();
    selectedItems.forEach((selected) => {
      map.set(selected.item_id, (map.get(selected.item_id) ?? 0) + selected.quantity);
    });
    return map;
  }, [selectedItems]);

  const categorySelectedCountMap = useMemo(() => {
    const map = new Map<string, number>();
    selectedItems.forEach((selected) => {
      const item = priceMap.get(selected.item_id);
      const category = item?.category ?? "";
      if (!category) return;
      map.set(category, (map.get(category) ?? 0) + selected.quantity);
    });
    return map;
  }, [selectedItems, priceMap]);

  useEffect(() => {
    if (selectedMember) {
      return;
    }
    setTopupAmount(0);
    setShowTopupPanel(false);
  }, [selectedMember]);

  useEffect(() => {
    if (!flashItemId) {
      return;
    }
    const timer = window.setTimeout(() => setFlashItemId(null), 800);
    return () => window.clearTimeout(timer);
  }, [flashItemId]);

  async function searchMembers() {
    setMemberLoading(true);
    setError("");
    try {
      const result = await searchMembersLocal(memberKeyword);
      setMemberResults(result);
      setMemberKeyword("");
      return result;
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "會員搜尋失敗");
      return [] as Member[];
    } finally {
      setMemberLoading(false);
    }
  }

  function toggleMember(member: Member) {
    if (selectedMember?.member_id === member.member_id) {
      setSelectedMember(null);
      setMemberResults([]);
      return;
    }
    setSelectedMember(member);
    setMemberResults([member]);
    setMemberKeyword("");
  }

  function addItem(itemId: string) {
    setFlashItemId(itemId);
    setSelectedItems((prev) => {
      const existing = prev.find((row) => row.item_id === itemId);
      if (existing) {
        return prev.map((row) =>
          row.item_id === itemId ? { ...row, quantity: row.quantity + 1 } : row,
        );
      }

      const item = priceMap.get(itemId);
      if (!item) {
        return [...prev, { item_id: itemId, quantity: 1 }];
      }

      const meta = getPriceChoiceMeta(item);
      if (!meta.requiresChoice) {
        if (!meta.shareMissing && meta.sharePreset) {
          return [
            ...prev,
            {
              item_id: itemId,
              quantity: 1,
              price_choice: "SHARE",
              manual_unit_price: meta.sharePreset,
            },
          ];
        }
        if (meta.originalPreset) {
          return [
            ...prev,
            {
              item_id: itemId,
              quantity: 1,
              price_choice: "ORIGINAL",
              manual_unit_price: meta.originalPreset,
            },
          ];
        }
        return [...prev, { item_id: itemId, quantity: 1 }];
      }

      if (!meta.shareMissing && meta.sharePreset) {
        return [
          ...prev,
          {
            item_id: itemId,
            quantity: 1,
            price_choice: "SHARE",
            manual_unit_price: meta.sharePreset,
          },
        ];
      }

      if (meta.originalPreset) {
        return [
          ...prev,
          {
            item_id: itemId,
            quantity: 1,
            price_choice: "ORIGINAL",
            manual_unit_price: meta.originalPreset,
          },
        ];
      }

      if (meta.sharePreset) {
        return [
          ...prev,
          {
            item_id: itemId,
            quantity: 1,
            price_choice: "SHARE",
            manual_unit_price: meta.sharePreset,
          },
        ];
      }

      if (meta.rangePreset && meta.rangeSource) {
        return [
          ...prev,
          {
            item_id: itemId,
            quantity: 1,
            price_choice: meta.rangeSource,
            manual_unit_price: meta.rangePreset,
          },
        ];
      }

      return [...prev, { item_id: itemId, quantity: 1, price_choice: "MANUAL" }];
    });
  }

  function updateItem(itemId: string, patch: Partial<SelectedItem>) {
    setSelectedItems((prev) =>
      prev.map((row) => (row.item_id === itemId ? { ...row, ...patch } : row)),
    );
  }

  function removeItem(itemId: string) {
    setSelectedItems((prev) => prev.filter((row) => row.item_id !== itemId));
    setManualPriceDraftMap((prev) => {
      if (!(itemId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
    delete manualPriceInputRefs.current[itemId];
  }

  function setManualPriceInputRef(itemId: string, node: HTMLInputElement | null) {
    if (!node) {
      delete manualPriceInputRefs.current[itemId];
      return;
    }
    manualPriceInputRefs.current[itemId] = node;
  }

  function focusManualPriceInput(itemId: string) {
    window.setTimeout(() => {
      const input = manualPriceInputRefs.current[itemId];
      if (!input) {
        return;
      }
      input.focus();
      const cursor = input.value.length;
      try {
        input.setSelectionRange(cursor, cursor);
      } catch {
        // 部分浏览器不支持 setSelectionRange
      }
    }, 0);
  }

  function normalizeManualPriceInput(raw: string) {
    const replaced = raw.replace(/[，。]/g, ".").replace(/,/g, ".");
    let normalized = "";
    let hasDot = false;
    for (const char of replaced) {
      if (/\d/.test(char)) {
        normalized += char;
        continue;
      }
      if (char === "." && !hasDot) {
        normalized += ".";
        hasDot = true;
      }
    }
    return normalized;
  }

  function getManualDraftValue(itemId: string, fallback?: number) {
    const fromDraft = manualPriceDraftMap[itemId];
    if (fromDraft !== undefined) {
      return fromDraft;
    }
    if (typeof fallback === "number" && Number.isFinite(fallback)) {
      return String(fallback);
    }
    return "";
  }

  function applyManualPriceDraft(itemId: string, raw: string) {
    const nextDraft = normalizeManualPriceInput(raw);
    setManualPriceDraftMap((prev) => ({ ...prev, [itemId]: nextDraft }));
    if (nextDraft === "" || nextDraft === ".") {
      updateItem(itemId, { price_choice: "MANUAL", manual_unit_price: undefined });
      return;
    }
    const parsed = Number(nextDraft);
    updateItem(itemId, {
      price_choice: "MANUAL",
      manual_unit_price: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
    });
  }

  function appendManualDecimalPoint(itemId: string, fallback?: number) {
    const current = getManualDraftValue(itemId, fallback);
    if (current.includes(".")) {
      return;
    }
    const next = current ? `${current}.` : "0.";
    applyManualPriceDraft(itemId, next);
  }

  function backspaceManualPrice(itemId: string, fallback?: number) {
    const current = getManualDraftValue(itemId, fallback);
    if (!current) {
      applyManualPriceDraft(itemId, "");
      return;
    }
    applyManualPriceDraft(itemId, current.slice(0, -1));
  }

  function clearManualPrice(itemId: string) {
    applyManualPriceDraft(itemId, "");
  }

  function toggleTopupPanel() {
    setShowTopupPanel((prev) => {
      const next = !prev;
      if (!next) {
        setTopupAmount(0);
      }
      return next;
    });
  }

  function toggleManualDiscountPanel() {
    setShowManualDiscountPanel((prev) => !prev);
  }

  async function updateMemberTier(nextValue: string) {
    if (!selectedMember) {
      return;
    }
    const parsedRate = nextValue === "" ? undefined : Number(nextValue);
    if (
      nextValue !== "" &&
      (!Number.isFinite(parsedRate) || !parsedRate || parsedRate <= 0 || parsedRate > 1)
    ) {
      return;
    }

    const prevMember = selectedMember;
    const nextMember: Member = {
      ...prevMember,
      manual_locked_discount_rate: parsedRate,
      updated_at: nowHongKong().createdAt,
    };

    setUpdatingTier(true);
    setTierUpdateMessage("");
    setSelectedMember(nextMember);
    setMemberResults((prev) =>
      prev.map((member) => (member.member_id === nextMember.member_id ? nextMember : member)),
    );
    try {
      await upsertMemberLocal(nextMember);
      setTierUpdateMessage(t("已更新手動折扣檔位", "Manual tier updated"));
    } catch (updateError) {
      setSelectedMember(prevMember);
      setMemberResults((prev) =>
        prev.map((member) => (member.member_id === prevMember.member_id ? prevMember : member)),
      );
      setError(updateError instanceof Error ? updateError.message : t("更新失敗", "Update failed"));
    } finally {
      setUpdatingTier(false);
    }
  }

  async function retryMemberMail() {
    if (!lastMailPayload) {
      return;
    }
    setSubmitLoading(true);
    setSubmitStage("MAILING");
    setMailStatus("IDLE");
    setMailStatusText(t("正在重試發送郵件...", "Retrying receipt email..."));
    try {
      await sendReceiptMailWithRetry(lastMailPayload, 3);
      setMailStatus("SENT");
      setMailStatusText(t("會員郵件已發送", "Receipt email sent"));
      setSubmitResult(t("記賬成功，會員郵件已發送", "Saved, receipt email sent"));
    } catch {
      setMailStatus("FAILED");
      setMailStatusText(t("會員郵件發送失敗，可重試", "Receipt email failed, retry available"));
      setSubmitResult(t("記賬成功，但會員郵件發送失敗", "Saved, but receipt email failed"));
    } finally {
      setSubmitStage("IDLE");
      setSubmitLoading(false);
    }
  }

  async function submitCheckout() {
    if (updatingTier) {
      setError(t("手動折扣正在更新，請稍候再提交", "Manual tier is updating, please wait"));
      return;
    }
    if (selectedItems.length === 0) {
      setError(t("請至少選擇 1 個項目", "Please select at least 1 item"));
      return;
    }

    setSubmitLoading(true);
    setSubmitStage("SAVING");
    setError("");
    setSubmitResult("");
    setMailStatus("IDLE");
    setMailStatusText("");
    setLastMailPayload(null);
    setLastSummary(null);

    const requestId = pendingRequestId ?? crypto.randomUUID();
    setPendingRequestId(requestId);

    try {
      setSubmitResult(t("正在記賬...", "Saving record..."));
      const result = await executeCheckoutLocal({
        request_id: requestId,
        member_id: selectedMember?.member_id,
        guest_gender: walkInGender || undefined,
        items: selectedItems,
        topup_amount: topupAmount,
        extra_discount_amount: extraDiscountAmount,
        apply_floor_discount: selectedMember ? applyFloorDiscount : true,
        notes,
        discount_reason: discountReason,
        source_device: detectDevice(),
      });

      if (result.alreadyProcessed) {
        setSubmitResult(t("同一單據已處理", "Same ticket already processed"));
      } else {
        setSubmitResult(t("記賬成功", "Saved"));
      }

      const spendRecord = result.records.find((row) => row.txn_type === "SPEND");
      if (result.preview && spendRecord) {
        const summary: CheckoutSummary = {
          isMember: Boolean(selectedMember),
          memberName: spendRecord.member_name_snapshot || (selectedMember?.name ?? "散客"),
          bizDate: spendRecord.biz_date,
          bizTime: spendRecord.biz_time,
          discountRate: result.preview.discount_rate,
          grossAmount: result.preview.gross_amount,
          memberDeductAmount: result.preview.net_amount,
          externalPayAmount: result.preview.external_pay_amount ?? 0,
          extraDiscountAmount: result.preview.extra_discount_amount ?? 0,
          floorDiscountAmount: result.preview.floor_discount_amount ?? 0,
          totalPayableAmount:
            result.preview.net_amount + (result.preview.external_pay_amount ?? 0),
          memberSavingsAmount: Math.max(
            result.preview.gross_amount -
              (result.preview.net_amount + (result.preview.external_pay_amount ?? 0)),
            0,
          ),
          balanceBeforeTopup: selectedMember?.balance ?? 0,
          topupAmount,
          balanceBeforeDeduct: spendRecord.balance_before,
          balanceAfter: spendRecord.balance_after,
          notes,
          items: result.preview.line_items.map((line) => ({
            item_id: line.item_id,
            item_name: line.item_name,
            item_name_en: priceMap.get(line.item_id)?.item_name_en?.trim() || undefined,
            category: line.category,
            category_en: priceMap.get(line.item_id)?.category_en?.trim() || undefined,
            quantity: line.quantity,
            unit_price: line.unit_price,
            line_amount: line.line_amount,
          })),
        };
        setLastSummary(summary);
      }

      setSelectedItems([]);
      setManualPriceDraftMap({});
      setTopupAmount(0);
      setExtraDiscountAmount(0);
      setApplyFloorDiscount(false);
      setShowTopupPanel(false);
      setShowManualDiscountPanel(false);
      setNotes("");
      setDiscountReason("");
      setPendingRequestId(null);
      const latestTransactions = await getTransactionsLocal();
      setTransactions(latestTransactions);

      let latestMember: Member | null = null;
      if (selectedMember) {
        latestMember = await getMemberByIdLocal(selectedMember.member_id);
        if (latestMember) {
          setSelectedMember(latestMember);
          setMemberResults([latestMember]);
        }
      }

      const spendRecordForMail = result.records.find((row) => row.txn_type === "SPEND");
      if (
        !result.alreadyProcessed &&
        selectedMember &&
        selectedMember.email.trim() &&
        result.preview &&
        spendRecordForMail
      ) {
        const mailPayload: ReceiptMailPayload = {
          lang: settlementLanguage,
          to_email: selectedMember.email.trim(),
          member_name: selectedMember.name,
          biz_date: spendRecordForMail.biz_date,
          biz_time: spendRecordForMail.biz_time,
          gross_amount: result.preview.gross_amount,
          member_deduct_amount: result.preview.net_amount,
          external_pay_amount: result.preview.external_pay_amount ?? 0,
          extra_discount_amount: result.preview.extra_discount_amount ?? 0,
          floor_discount_amount: result.preview.floor_discount_amount ?? 0,
          total_payable_amount:
            result.preview.net_amount + (result.preview.external_pay_amount ?? 0),
          discount_rate: result.preview.discount_rate,
          balance_before_topup: selectedMember.balance,
          topup_amount: topupAmount,
          balance_before_deduct: spendRecordForMail.balance_before,
          balance_after: spendRecordForMail.balance_after,
          store_profile: storeProfile ?? undefined,
          notes,
          items: result.preview.line_items.map((line) => ({
            item_id: line.item_id,
            item_name: line.item_name,
            item_name_en: priceMap.get(line.item_id)?.item_name_en?.trim() || undefined,
            category: line.category,
            category_en: priceMap.get(line.item_id)?.category_en?.trim() || undefined,
            quantity: line.quantity,
            unit_price: line.unit_price,
            line_amount: line.line_amount,
          })),
        };
        setLastMailPayload(mailPayload);
        setSubmitStage("MAILING");
        setSubmitResult(t("記賬成功，正在發送郵件...", "Saved, sending receipt email..."));
        setMailStatusText(t("正在發送會員郵件...", "Sending receipt email..."));
        try {
          await sendReceiptMailWithRetry(mailPayload, 3);
          setMailStatus("SENT");
          setMailStatusText(t("會員郵件已發送", "Receipt email sent"));
          setSubmitResult(t("記賬成功，會員郵件已發送", "Saved, receipt email sent"));
        } catch {
          setMailStatus("FAILED");
          setMailStatusText(t("會員郵件發送失敗，可重試", "Receipt email failed, retry available"));
          setSubmitResult(t("記賬成功，但會員郵件發送失敗", "Saved, but receipt email failed"));
        }
      } else if (selectedMember && !selectedMember.email.trim()) {
        setMailStatus("SKIPPED");
        setMailStatusText(t("會員未設定郵箱，本單不發送郵件", "No member email, skip sending"));
        setSubmitResult(t("記賬成功，會員未設定郵箱", "Saved, member email not set"));
      } else {
        setMailStatus("SKIPPED");
        setMailStatusText(t("本單無需發送會員郵件", "No receipt email needed"));
      }

      if (!latestMember && selectedMember) {
        const latestMembers = await searchMembers();
        setMemberResults(latestMembers);
      }
    } catch (submitError) {
      const fallbackMessage = t("提交失敗，請重試", "Submit failed, please retry");
      const rawMessage = submitError instanceof Error ? submitError.message : fallbackMessage;
      const message = rawMessage === "提交失敗，請重試" ? fallbackMessage : rawMessage;
      setError(message);
      if (message.includes("餘額不足")) {
        setError(
          t(
            "會員餘額不足：本次先扣餘額，剩餘金額按原價收取。",
            "Insufficient member balance: deduct member balance first, remaining amount charged at original price.",
          ),
        );
        setShowTopupPanel(true);
      }
      setSubmitResult("");
      setMailStatus("IDLE");
      setMailStatusText("");
    } finally {
      setSubmitStage("IDLE");
      setSubmitLoading(false);
    }
  }

  function openConfirmSubmit() {
    if (submitLoading || updatingTier) {
      if (updatingTier) {
        setError(t("手動折扣正在更新，請稍候", "Manual tier is updating, please wait"));
      }
      return;
    }
    if (selectedItems.length === 0) {
      setError(t("請至少選擇 1 個項目", "Please select at least 1 item"));
      return;
    }
    if (!preview) {
      setError(t("請先完成本單價格設定", "Please finish pricing setup first"));
      return;
    }
    setError("");
    setConfirmOpen(true);
  }

  if (loading) {
    return <div className="rounded-2xl bg-white p-6 text-slate-600">加載中...</div>;
  }

  if (error && !config) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-rose-700">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="text-sm font-semibold text-slate-700">1) 搜尋會員（無會員，可跳過）</p>
        <div className="mt-2 flex gap-2">
          <input
            value={memberKeyword}
            onChange={(event) => setMemberKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !memberLoading) {
                event.preventDefault();
                void searchMembers();
              }
            }}
            placeholder="輸入姓名或電話"
            className="h-12 flex-1 rounded-xl border border-slate-200 px-3 text-base"
          />
          <button
            type="button"
            onClick={searchMembers}
            disabled={memberLoading}
            className="h-12 rounded-xl bg-cyan-700 px-5 text-base font-semibold text-white disabled:opacity-60"
          >
            {memberLoading ? "搜尋中" : "搜尋"}
          </button>
          {selectedMember && (
            <button
              type="button"
              onClick={() => setSelectedMember(null)}
              className="h-12 rounded-xl bg-slate-200 px-4 text-sm font-semibold text-slate-700"
            >
              取消選中
            </button>
          )}
        </div>
        {!selectedMember && (
          <div className="mt-2 flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            <span className="font-semibold text-slate-700">散客性別</span>
            <label className="flex items-center gap-1 text-slate-700">
              <input
                type="radio"
                name="walkin-gender"
                checked={walkInGender === ""}
                onChange={() => setWalkInGender("")}
              />
              不填
            </label>
            <label className="flex items-center gap-1 text-slate-700">
              <input
                type="radio"
                name="walkin-gender"
                checked={walkInGender === "女"}
                onChange={() => setWalkInGender("女")}
              />
              女
            </label>
            <label className="flex items-center gap-1 text-slate-700">
              <input
                type="radio"
                name="walkin-gender"
                checked={walkInGender === "男"}
                onChange={() => setWalkInGender("男")}
              />
              男
            </label>
          </div>
        )}
        {memberResults.length > 0 && !selectedMember && (
          <div className="mt-3 grid gap-2">
            {memberResults.map((member) => (
              <button
                key={member.member_id}
                type="button"
                onClick={() => toggleMember(member)}
                className="rounded-xl border border-slate-200 p-3 text-left"
              >
                <p className="text-base font-semibold text-slate-800">
                  {member.name} · {member.phone}
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  當前餘額：{formatCurrency(member.balance)}
                </p>
              </button>
            ))}
          </div>
        )}
        {selectedMember && (
          <div className="mt-3 rounded-2xl border border-cyan-200 bg-cyan-50/60 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-base font-bold text-cyan-900">會員資料確認</p>
              <p className="text-sm font-semibold text-cyan-700">今天：{todayBizDate}</p>
            </div>
            {(() => {
              const optionalFields = [
                { label: "電郵", value: selectedMember.email },
                { label: "性別", value: selectedMember.gender },
                { label: "生日", value: selectedMember.birthday },
                { label: "卡號", value: selectedMember.card_no },
                { label: "微信/WhatsApp", value: selectedMember.wechat_or_whatsapp },
                { label: "註冊日期", value: selectedMember.register_date },
              ].filter((field) => (field.value ?? "").toString().trim() !== "");

              return (
                <>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    <div>
                      <p className="text-xs text-slate-500">姓名</p>
                      <p className="text-xl font-bold text-slate-900">{selectedMember.name}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">電話</p>
                      <p className="text-xl font-bold text-slate-900">{selectedMember.phone}</p>
                    </div>
                    {optionalFields.map((field) => (
                      <div key={field.label}>
                        <p className="text-xs text-slate-500">{field.label}</p>
                        <p className="text-lg font-semibold text-slate-900">{field.value}</p>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              <div className="rounded-xl bg-white p-3">
                <p className="text-xs text-slate-500">當前餘額</p>
                <p className="text-2xl font-bold text-emerald-700">
                  {formatCurrency(selectedMember.balance)}
                </p>
              </div>
              <div className="rounded-xl bg-white p-3">
                <p className="text-xs text-slate-500">當前折扣檔位</p>
                <p className="text-2xl font-bold text-cyan-700">
                  {(selectedMemberDiscountRate * 10).toFixed(1)} 折
                  <span className="ml-1 text-base font-semibold text-cyan-700">
                    ({(selectedMemberDiscountRate * 100).toFixed(0)}%)
                  </span>
                </p>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="text-sm font-semibold text-slate-700">2) 選擇項目</p>
        <p className="mt-1 text-xs text-slate-500">點同一個項目可快速增加數量，已選會顯示數量標記。</p>
        <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
          {categories.map((category) => {
            const categorySelectedCount = categorySelectedCountMap.get(category) ?? 0;
            return (
              <button
                key={category}
                type="button"
                onClick={() => setActiveCategory(category)}
                className={`inline-flex items-center justify-center gap-1 rounded-xl px-3 py-2 text-center text-sm font-semibold ${
                  activeCategory === category
                    ? "bg-cyan-700 text-white"
                    : "bg-slate-100 text-slate-700"
                }`}
              >
                <span>{displayCategory(category)}</span>
                {categorySelectedCount > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
                      activeCategory === category
                        ? "bg-white/20 text-white"
                        : "bg-cyan-700 text-white"
                    }`}
                  >
                    x{categorySelectedCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {categoryItems.map((item) => {
            const selectedCount = selectedCountMap.get(item.item_id) ?? 0;
            const isSelected = selectedCount > 0;
            const shareRaw = (item.share_price ?? "").trim();
            const shareDisplay =
              shareRaw && shareRaw !== "-" && shareRaw !== "--" && shareRaw !== "000" && shareRaw !== "0"
                ? shareRaw
                : "無（按原價/手選）";

            return (
              <button
                key={item.item_id}
                type="button"
                onClick={() => addItem(item.item_id)}
                className={`rounded-xl border p-3 text-left transition ${
                  isSelected ? "border-cyan-700 bg-cyan-50" : "border-slate-200"
                } ${flashItemId === item.item_id ? "ring-2 ring-cyan-300" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-base font-semibold text-slate-900">
                    {displayItemName(item.item_name, item.item_id)}
                  </p>
                  {isSelected && (
                    <span className="rounded-full bg-cyan-700 px-2 py-0.5 text-xs font-semibold text-white">
                      x{selectedCount}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  分享價：{shareDisplay} ｜ 原價：{item.original_price || "-"}
                </p>
              </button>
            );
          })}
        </div>
      </section>

      {selectedItems.length > 0 && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-sm font-semibold text-slate-700">3) 本單項目</p>
          <div className="mt-2 space-y-2">
            {selectedItems.map((selected) => {
              const item = priceMap.get(selected.item_id);
              if (!item) return null;
              const choiceMeta = getPriceChoiceMeta(item);
              const showManualInput = choiceMeta.requiresChoice && selected.price_choice === "MANUAL";
              const manualDraft = getManualDraftValue(
                selected.item_id,
                selected.manual_unit_price,
              );
              return (
                <div key={selected.item_id} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-slate-900">
                      {displayItemName(item.item_name, item.item_id)}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          updateItem(selected.item_id, {
                            quantity: Math.max(1, selected.quantity - 1),
                          })
                        }
                        className="h-9 w-9 rounded-lg bg-slate-200 text-lg"
                      >
                        -
                      </button>
                      <span className="w-7 text-center font-semibold">{selected.quantity}</span>
                      <button
                        type="button"
                        onClick={() =>
                          updateItem(selected.item_id, {
                            quantity: Math.min(20, selected.quantity + 1),
                          })
                        }
                        className="h-9 w-9 rounded-lg bg-slate-200 text-lg"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        onClick={() => removeItem(selected.item_id)}
                        className="ml-2 text-sm font-semibold text-rose-600"
                      >
                        刪除
                      </button>
                    </div>
                  </div>
                  {choiceMeta.requiresChoice && (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                      <p className="text-xs font-semibold text-amber-700">請選本次單價</p>
                      <div
                        className={`mt-2 grid gap-2 ${
                          choiceMeta.hasRange ? "md:grid-cols-4" : "md:grid-cols-3"
                        }`}
                      >
                        <button
                          type="button"
                          disabled={!choiceMeta.sharePreset}
                          onClick={() =>
                            updateItem(selected.item_id, {
                              price_choice: "SHARE",
                              manual_unit_price: choiceMeta.sharePreset ?? undefined,
                            })
                          }
                          className={`h-10 rounded-lg border text-sm font-semibold ${
                            selected.price_choice === "SHARE" &&
                            selected.manual_unit_price === choiceMeta.sharePreset
                              ? "border-cyan-700 bg-cyan-700 text-white"
                              : "border-slate-200 bg-white text-slate-700"
                          } disabled:cursor-not-allowed disabled:opacity-40`}
                        >
                          分享價 {choiceMeta.sharePreset ? choiceMeta.sharePreset : "-"}
                        </button>
                        <button
                          type="button"
                          disabled={!choiceMeta.originalPreset}
                          onClick={() =>
                            updateItem(selected.item_id, {
                              price_choice: "ORIGINAL",
                              manual_unit_price: choiceMeta.originalPreset ?? undefined,
                            })
                          }
                          className={`h-10 rounded-lg border text-sm font-semibold ${
                            selected.price_choice === "ORIGINAL" &&
                            selected.manual_unit_price === choiceMeta.originalPreset
                              ? "border-cyan-700 bg-cyan-700 text-white"
                              : "border-slate-200 bg-white text-slate-700"
                          } disabled:cursor-not-allowed disabled:opacity-40`}
                        >
                          原價 {choiceMeta.originalPreset ? choiceMeta.originalPreset : "-"}
                        </button>
                        {choiceMeta.hasRange && choiceMeta.rangePreset && (
                          <button
                            type="button"
                            onClick={() =>
                              updateItem(selected.item_id, {
                                price_choice: choiceMeta.rangeSource === "SHARE" ? "SHARE" : "ORIGINAL",
                                manual_unit_price: choiceMeta.rangePreset ?? undefined,
                              })
                            }
                            className={`h-10 rounded-lg border text-sm font-semibold ${
                              selected.price_choice === choiceMeta.rangeSource &&
                              selected.manual_unit_price === choiceMeta.rangePreset
                                ? "border-cyan-700 bg-cyan-700 text-white"
                                : "border-slate-200 bg-white text-slate-700"
                            }`}
                          >
                            區間價 {choiceMeta.rangePreset}
                          </button>
                        )}
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() =>
                            {
                              updateItem(selected.item_id, {
                                price_choice: "MANUAL",
                                manual_unit_price:
                                  selected.price_choice === "MANUAL" ? selected.manual_unit_price : undefined,
                              });
                              focusManualPriceInput(selected.item_id);
                            }
                          }
                          className={`h-10 rounded-lg border text-sm font-semibold ${
                            selected.price_choice === "MANUAL"
                              ? "border-cyan-700 bg-cyan-700 text-white"
                              : "border-slate-200 bg-white text-slate-700"
                          }`}
                        >
                          手選
                        </button>
                      </div>

                      {showManualInput && (
                        <div className="mt-2 space-y-2">
                          <input
                            type="text"
                            inputMode="decimal"
                            pattern="[0-9]*[.]?[0-9]*"
                            ref={(node) => setManualPriceInputRef(selected.item_id, node)}
                            value={manualDraft}
                            onChange={(event) => applyManualPriceDraft(selected.item_id, event.target.value)}
                            placeholder="請輸入本次單價"
                            className="h-11 w-full rounded-lg border border-amber-300 bg-white px-3"
                          />
                          <div className="grid grid-cols-3 gap-2">
                            <button
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                appendManualDecimalPoint(selected.item_id, selected.manual_unit_price);
                                focusManualPriceInput(selected.item_id);
                              }}
                              className="h-10 rounded-lg border border-amber-300 bg-white text-sm font-semibold text-amber-800"
                            >
                              小數點 .
                            </button>
                            <button
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                backspaceManualPrice(selected.item_id, selected.manual_unit_price);
                                focusManualPriceInput(selected.item_id);
                              }}
                              className="h-10 rounded-lg border border-amber-300 bg-white text-sm font-semibold text-amber-800"
                            >
                              退格
                            </button>
                            <button
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                clearManualPrice(selected.item_id);
                                focusManualPriceInput(selected.item_id);
                              }}
                              className="h-10 rounded-lg border border-amber-300 bg-white text-sm font-semibold text-amber-800"
                            >
                              清空
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-700">
            {t("4) 充值與結算", "4) Top-up & Checkout")}
          </p>
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1 text-xs">
            <button
              type="button"
              onClick={() => setSettlementLanguage("zh")}
              className={`rounded-md px-3 py-1 font-semibold ${
                settlementLanguage === "zh" ? "bg-cyan-700 text-white" : "text-slate-600"
              }`}
            >
              中文
            </button>
            <button
              type="button"
              onClick={() => setSettlementLanguage("en")}
              className={`rounded-md px-3 py-1 font-semibold ${
                settlementLanguage === "en" ? "bg-cyan-700 text-white" : "text-slate-600"
              }`}
            >
              English
            </button>
          </div>
        </div>
        {selectedMember ? (
          <div className="mt-2 flex items-center justify-between rounded-xl bg-slate-50 p-3">
            <p className="text-sm text-slate-600">
              {t("充值面板：", "Top-up panel: ")}
              {showTopupPanel ? t("已展開", "Expanded") : t("已收起", "Collapsed")}
            </p>
            <button
              type="button"
              onClick={toggleTopupPanel}
              className="rounded-lg bg-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700"
            >
              {showTopupPanel ? t("收起充值", "Hide top-up") : t("展開充值", "Show top-up")}
            </button>
          </div>
        ) : (
          <div className="mt-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
            {t(
              "本單為散客記賬：不走會員儲值與會員折扣；項目單價可選分享價/原價/區間價/手選。",
              "Walk-in order: no member balance or member discount; item unit price can use Share / Original / Range / Manual.",
            )}
          </div>
        )}

        {selectedMember && preview && preview.settlementMode === "PARTIAL_BALANCE" && (
          <p className="mt-2 text-sm font-semibold text-rose-700">
            {t(
              "會員餘額不足：本次先扣餘額，剩餘金額按原價收取。",
              "Insufficient member balance: deduct member balance first, remaining amount charged at original price.",
            )}
          </p>
        )}

        {selectedMember && showTopupPanel && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-slate-500">
              {t(
                `快捷充值（會員檔位）：${discountTierText}；也可手動輸入任意金額。`,
                `Quick top-up (member tiers): ${discountTierText}; you can also enter any amount manually.`,
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setTopupAmount(0)}
                className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                  topupAmount === 0 ? "bg-cyan-700 text-white" : "bg-slate-100 text-slate-700"
                }`}
              >
                {t("不充值", "No top-up")}
              </button>
              {quickTopupOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTopupAmount(value)}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                    topupAmount === value ? "bg-cyan-700 text-white" : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {(() => {
                    const rate = getDiscountRateByTopupAmount(value, config?.discountTiers);
                    const discountText = (rate * 10).toFixed(rate * 10 % 1 === 0 ? 0 : 1);
                    return t(
                      `充值${value}（${discountText}折）`,
                      `Top-up ${value} (${discountText} off)`,
                    );
                  })()}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-600">{t("手動充值", "Manual top-up")}</label>
              <input
                type="number"
                inputMode="decimal"
                value={topupAmount > 0 ? topupAmount : ""}
                onChange={(event) => setTopupAmount(Number(event.target.value || "0"))}
                placeholder={t("輸入自訂金額，例如 800", "Enter custom amount, e.g. 800")}
                className="h-10 w-56 rounded-lg border border-slate-200 px-3"
              />
            </div>
          </div>
        )}

        {selectedMember && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-3">
            <label className="text-sm text-slate-600">{t("手動折扣", "Manual tier")}</label>
            <select
              value={
                selectedMember.manual_locked_discount_rate === undefined
                  ? ""
                  : String(selectedMember.manual_locked_discount_rate)
              }
              onChange={(event) => {
                void updateMemberTier(event.target.value);
              }}
              disabled={updatingTier || submitLoading}
              className="h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 disabled:opacity-60"
            >
              <option value="">{t("自動（按歷史/充值）", "Auto (history/top-up)")}</option>
              {manualTierOptions.map((rate) => {
                const discountText = (rate * 10).toFixed(rate * 10 % 1 === 0 ? 0 : 1);
                return (
                  <option key={rate} value={rate}>
                    {`${discountText}${t("折", " off")} (${(rate * 100).toFixed(0)}%)`}
                  </option>
                );
              })}
            </select>
            {updatingTier && (
              <span className="text-xs text-slate-500">
                {t("正在更新手動折扣...", "Updating manual tier...")}
              </span>
            )}
            {tierUpdateMessage && <span className="text-xs text-emerald-700">{tierUpdateMessage}</span>}
          </div>
        )}

        <div className="mt-3 rounded-xl bg-slate-50 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-600">
              {t("手動優惠面板：", "Manual discount panel: ")}
              {showManualDiscountPanel ? t("已展開", "Expanded") : t("已收起", "Collapsed")}
            </p>
            <button
              type="button"
              onClick={toggleManualDiscountPanel}
              className="rounded-lg bg-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700"
            >
              {showManualDiscountPanel
                ? t("收起手動優惠", "Hide manual discount")
                : t("展開手動優惠", "Show manual discount")}
            </button>
          </div>
          {showManualDiscountPanel && (
            <div className="mt-2 rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs font-semibold text-slate-700">
                {t("手動優惠", "Manual discount")}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {t(
                  "可選抹小數（向下取整），再套用手動優惠。",
                  "Optional decimal floor first, then apply manual discount.",
                )}
              </p>
              {selectedMember && (
                <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={applyFloorDiscount}
                    onChange={(event) => setApplyFloorDiscount(event.target.checked)}
                  />
                  {t("抹小數（向下取整）", "Floor decimals")}
                </label>
              )}
              <div className="mt-2 flex items-center gap-2">
                <label className="text-sm text-slate-600">
                  {t("手動優惠 HKD", "Manual discount HKD")}
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={extraDiscountAmount > 0 ? extraDiscountAmount : ""}
                  onChange={(event) =>
                    setExtraDiscountAmount(Math.max(0, Number(event.target.value || "0")))
                  }
                  placeholder={t("輸入優惠金額，例如 10", "Enter discount amount, e.g. 10")}
                  className="h-10 w-56 rounded-lg border border-slate-200 px-3"
                />
              </div>
            </div>
          )}
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={t("備註（可選）", "Note (optional)")}
            className="h-11 rounded-lg border border-slate-200 px-3"
          />
          <input
            value={discountReason}
            onChange={(event) => setDiscountReason(event.target.value)}
            placeholder={t("折扣說明（可選）", "Discount reason (optional)")}
            className="h-11 rounded-lg border border-slate-200 px-3"
          />
        </div>

        {preview && (
          <div className="mt-4 rounded-xl bg-slate-50 p-3">
            <div className="rounded-lg border border-slate-200 bg-white">
              {(() => {
                const showExternalColumn = !selectedMember || preview.settlementMode === "PARTIAL_BALANCE";
                const discountTextBase = `${(preview.discountRate * 100).toFixed(0)}%`;
                return (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">{t("項目", "Item")}</th>
                      <th className="px-3 py-2 text-right font-semibold">
                        {t("原價小計", "Gross")}
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">
                        {t("折扣", "Discount")}
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">
                        {t("會員折後", "Member")}
                      </th>
                      {showExternalColumn && (
                        <th className="px-3 py-2 text-right font-semibold">
                          {t("餘額外原價", "Extra")}
                        </th>
                      )}
                      <th className="px-3 py-2 text-right font-semibold">
                        {t("本項應收", "Payable")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.lines.map((line, index) => (
                      <tr key={`${line.item_id || line.item_name}-${index}`}>
                        <td className="px-3 py-2 text-slate-700">
                          {displayCategory(line.category, settlementLanguage, line.item_id)}｜
                          {displayItemName(line.item_name, line.item_id, settlementLanguage)} x
                          {line.quantity}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                          {formatCurrency(line.gross)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                          {(() => {
                            const hasMemberPart = hasDisplayAmount(line.memberDeduct);
                            const hasExternalPart = hasDisplayAmount(line.externalPay);
                            if (!selectedMember) {
                              return t("原價", "Original");
                            }
                            if (hasMemberPart && hasExternalPart) {
                              return `${discountTextBase}${t("（部分）", " (Partial)")}`;
                            }
                            if (hasMemberPart) {
                              return discountTextBase;
                            }
                            return t("無折扣", "No discount");
                          })()}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium text-emerald-700">
                          {formatAmountOrDash(line.memberDeduct)}
                        </td>
                        {showExternalColumn && (
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-amber-700">
                            {formatAmountOrDash(line.externalPay)}
                          </td>
                        )}
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                          {formatCurrency(line.lineTotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t border-slate-200 bg-slate-50 text-sm">
                    <tr>
                      <td className="px-3 py-2 font-semibold text-slate-700">
                        {t("折前小計", "Subtotal")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                        {formatCurrency(preview.gross)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-600">
                        {selectedMember ? `${discountTextBase}` : t("原價", "Original")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-emerald-700">
                        {formatAmountOrDash(preview.memberDeductBeforeAdjust)}
                      </td>
                      {showExternalColumn && (
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-amber-700">
                          {formatAmountOrDash(preview.externalPayBeforeAdjust)}
                        </td>
                      )}
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                        {formatCurrency(preview.payableBeforeAdjust)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
                );
              })()}
            </div>
            {(preview.extraDiscountApplied > 0 || preview.hasFloorDiscount) && (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                {preview.hasFloorDiscount && (
                  <p>{t("已去小數：", "Decimal removed: ")}{formatCurrency(preview.floorDiscountApplied)}</p>
                )}
                {preview.extraDiscountApplied > 0 && (
                  <p>{t("手動優惠：", "Manual discount: ")}{formatCurrency(preview.extraDiscountApplied)}</p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
          <p className="text-sm font-semibold text-slate-800">{t("本單總覽", "Summary")}</p>
          {!preview && (
            <p className="mt-2 text-sm text-slate-600">
              {t("請先選擇項目並完成本次價格選擇。", "Please select items and finish pricing first.")}
            </p>
          )}
          {selectedMember && preview && (
            <div className="mt-2 space-y-2 text-sm text-slate-700">
              <p className="font-semibold text-slate-800">
                {t("會員姓名：", "Member: ")}
                {selectedMember.name} ｜ {t("折扣檔位：", "Tier: ")}
                {(preview.discountRate * 10).toFixed(1)} {t("折", "off")}（
                {(preview.discountRate * 100).toFixed(0)}%）
              </p>
              <div className="rounded-lg bg-slate-50 p-3">
                <div className="grid grid-cols-2 gap-y-2 text-sm">
                  <span className="text-slate-500">{t("原餘額", "Original balance")}</span>
                  <span className="text-right tabular-nums text-slate-800">
                    {formatCurrency(selectedMember.balance)}
                  </span>
                  <span className="text-slate-500">{t("今日消費", "Today's charge")}</span>
                  <span className="text-right tabular-nums font-semibold text-slate-900">
                    {formatCurrency(preview.totalPayable)}
                  </span>
                  <span className="text-slate-500">{t("扣後餘額", "Balance after")}</span>
                  <span className="text-right tabular-nums font-semibold text-cyan-700">
                    {formatCurrency(preview.balanceAfter)}
                  </span>
                  <span className="text-slate-500">{t("會員本單共省", "Saved this order")}</span>
                  <span className="text-right tabular-nums font-semibold text-cyan-700">
                    {formatCurrency(preview.memberSavings)}
                  </span>
                </div>
              </div>
            </div>
          )}
          {!selectedMember && preview && (
            <div className="mt-2 space-y-2 text-sm text-slate-700">
              <p className="text-2xl font-bold leading-tight text-cyan-700">
                {t("本次應收：", "Payable now: ")}
                {formatCurrency(preview.externalPay)}
              </p>
            </div>
          )}
        </div>

        {lastSummary && (
          <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-slate-900">
                {lastSummary.bizDate} {lastSummary.bizTime}｜{lastSummary.memberName}
              </p>
              <p className="font-semibold text-cyan-700">
                {t("折扣 ", "Discount ")}
                {(lastSummary.discountRate * 100).toFixed(0)}%
              </p>
            </div>
            <div className="mt-2 max-h-44 overflow-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-100 text-slate-600">
                  <tr>
                    <th className="px-2 py-1 text-left">{t("項目", "Item")}</th>
                    <th className="px-2 py-1 text-right">{t("小計", "Amount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {lastSummary.items.map((item, index) => (
                    <tr key={`${item.item_name}-${index}`} className="border-t border-slate-100">
                      <td className="px-2 py-1 text-slate-700">
                        {displayCategory(item.category, settlementLanguage, item.item_id)}｜
                        {displayItemName(item.item_name, item.item_id, settlementLanguage)} x
                        {item.quantity}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-700">
                        {formatCurrency(item.line_amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lastSummary.isMember ? (
              <div className="mt-2 grid grid-cols-2 gap-y-1">
                <span className="text-slate-500">{t("原餘額", "Original balance")}</span>
                <span className="text-right tabular-nums text-slate-700">
                  {formatCurrency(lastSummary.balanceBeforeTopup)}
                </span>
                <span className="text-slate-500">{t("今日消費", "Today's charge")}</span>
                <span className="text-right tabular-nums font-semibold text-slate-900">
                  {formatCurrency(lastSummary.totalPayableAmount)}
                </span>
                <span className="text-slate-500">{t("扣後餘額", "Balance after")}</span>
                <span className="text-right tabular-nums font-semibold text-cyan-700">
                  {formatCurrency(lastSummary.balanceAfter)}
                </span>
                <span className="text-slate-500">{t("會員卡本單已省", "Saved this order")}</span>
                <span className="text-right tabular-nums font-semibold text-cyan-700">
                  {formatAmountOrDash(lastSummary.memberSavingsAmount)}
                </span>
              </div>
            ) : (
              <div className="mt-2 grid grid-cols-2 gap-y-1">
                <span className="text-slate-500">{t("今日消費", "Today's charge")}</span>
                <span className="text-right tabular-nums font-semibold text-slate-900">
                  {formatCurrency(lastSummary.totalPayableAmount)}
                </span>
              </div>
            )}
          </div>
        )}

        {error && <p className="mt-3 text-sm font-semibold text-rose-600">{error}</p>}
        {submitResult && <p className="mt-3 text-sm font-semibold text-emerald-700">{submitResult}</p>}
        {mailStatusText && (
          <p
            className={`mt-2 text-sm font-semibold ${
              mailStatus === "FAILED"
                ? "text-rose-600"
                : mailStatus === "SENT"
                  ? "text-emerald-700"
                  : "text-slate-700"
            }`}
          >
            {mailStatusText}
          </p>
        )}
        {mailStatus === "FAILED" && lastMailPayload && (
          <button
            type="button"
            onClick={() => {
              void retryMemberMail();
            }}
            disabled={submitLoading}
            className="mt-2 h-10 rounded-xl bg-amber-600 px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            {t("重試發送郵件", "Retry email")}
          </button>
        )}

        <button
          type="button"
          onClick={openConfirmSubmit}
          disabled={submitLoading || updatingTier}
          className="mt-4 h-12 w-full rounded-2xl bg-cyan-700 text-lg font-semibold text-white disabled:opacity-60"
        >
          {updatingTier
            ? t("折扣更新中...", "Updating tier...")
            : submitLoading
            ? submitStage === "SAVING"
              ? t("正在記賬...", "Saving...")
              : t("正在發送郵件...", "Sending email...")
            : t("提交並記賬", "Submit & Save")}
        </button>
      </section>

      {confirmOpen && preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl">
            <h3 className="text-base font-bold text-slate-900">確認提交本單？</h3>
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="grid grid-cols-2 gap-y-1">
                <span className="text-slate-500">身份</span>
                <span className="text-right font-semibold text-slate-700">
                  {selectedMember ? selectedMember.name : "散客"}
                </span>
                <span className="text-slate-500">折前小計</span>
                <span className="text-right tabular-nums text-slate-700">
                  {formatCurrency(preview.gross)}
                </span>
                <span className="text-slate-500">折後小計（未調整）</span>
                <span className="text-right tabular-nums text-slate-700">
                  {formatCurrency(preview.payableBeforeAdjust)}
                </span>
                <span className="text-slate-500">會員扣款</span>
                <span className="text-right tabular-nums font-semibold text-emerald-700">
                  {formatAmountOrDash(preview.memberDeduct)}
                </span>
                {(!selectedMember || preview.settlementMode === "PARTIAL_BALANCE") && (
                  <>
                    <span className="text-slate-500">另收金額</span>
                    <span className="text-right tabular-nums font-semibold text-amber-700">
                      {formatAmountOrDash(preview.externalPay)}
                    </span>
                  </>
                )}
                <span className="text-slate-500">會員共省</span>
                <span className="text-right tabular-nums font-semibold text-cyan-700">
                  {formatAmountOrDash(preview.memberSavings)}
                </span>
                {preview.hasFloorDiscount && (
                  <>
                    <span className="text-slate-500">去小數優惠</span>
                    <span className="text-right tabular-nums font-semibold text-amber-700">
                      {formatAmountOrDash(preview.floorDiscountApplied)}
                    </span>
                  </>
                )}
                {hasDisplayAmount(preview.extraDiscountApplied) && (
                  <>
                    <span className="text-slate-500">手動優惠</span>
                    <span className="text-right tabular-nums font-semibold text-amber-700">
                      {formatAmountOrDash(preview.extraDiscountApplied)}
                    </span>
                  </>
                )}
                <span className="text-slate-500">最終應收</span>
                <span className="text-right tabular-nums font-semibold text-slate-900">
                  {formatCurrency(preview.totalPayable)}
                </span>
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="h-11 flex-1 rounded-xl border border-slate-300 bg-white font-semibold text-slate-700"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(false);
                  void submitCheckout();
                }}
                className="h-11 flex-1 rounded-xl bg-cyan-700 font-semibold text-white"
              >
                確認提交
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
