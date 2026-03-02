import type {
  ConfigRules,
  CurrencyCode,
  DiscountTier,
  PriceItem,
  PricingBasis,
  RoundingMode,
  TransactionRecord,
  TransactionLineItem,
} from "@/lib/types";

const DEFAULT_TIERS: DiscountTier[] = [
  { threshold: 10000, rate: 0.75 },
  { threshold: 5000, rate: 0.8 },
  { threshold: 3000, rate: 0.85 },
  { threshold: 1500, rate: 0.9 },
];

const INVALID_PRICE_TOKENS = new Set(["", "-", "--", "000", "0", "null", "n/a"]);

export interface ParsedConfiguredPrice {
  isValidNumber: boolean;
  requiresManualInput: boolean;
  amount: number;
}

export interface ResolvedLinePrice {
  basis: PricingBasis;
  unitSource: "share" | "original" | "manual";
  unitPrice: number;
  manualAdjusted: boolean;
}

export type PreferredUnitSource = "share" | "original" | "manual";

export function parseConfiguredPrice(input: string | number | null | undefined): ParsedConfiguredPrice {
  if (typeof input === "number") {
    return {
      isValidNumber: Number.isFinite(input) && input > 0,
      requiresManualInput: false,
      amount: Number.isFinite(input) && input > 0 ? input : 0,
    };
  }

  const raw = (input ?? "").toString().trim().toLowerCase();
  if (INVALID_PRICE_TOKENS.has(raw)) {
    return { isValidNumber: false, requiresManualInput: false, amount: 0 };
  }

  if (raw.includes("/") || raw.includes("up")) {
    return { isValidNumber: false, requiresManualInput: true, amount: 0 };
  }

  const normalized = raw.replace(/,/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { isValidNumber: false, requiresManualInput: false, amount: 0 };
  }

  return { isValidNumber: true, requiresManualInput: false, amount: parsed };
}

export function resolveLinePrice(
  item: PriceItem,
  manualUnitPrice?: number,
  preferredSource?: PreferredUnitSource,
): ResolvedLinePrice {
  const share = parseConfiguredPrice(item.share_price);
  const original = parseConfiguredPrice(item.original_price);

  if (preferredSource === "share") {
    if (share.isValidNumber) {
      return {
        basis: "share_price",
        unitSource: "share",
        unitPrice: share.amount,
        manualAdjusted: false,
      };
    }
    if (manualUnitPrice && manualUnitPrice > 0) {
      return {
        basis: "share_price",
        unitSource: "share",
        unitPrice: manualUnitPrice,
        manualAdjusted: true,
      };
    }
    throw new Error(`项目 ${item.item_name} 需要输入本次实际金额`);
  }

  if (preferredSource === "original") {
    if (original.isValidNumber) {
      return {
        basis: "original_price",
        unitSource: "original",
        unitPrice: original.amount,
        manualAdjusted: false,
      };
    }
    if (manualUnitPrice && manualUnitPrice > 0) {
      return {
        basis: "original_price",
        unitSource: "original",
        unitPrice: manualUnitPrice,
        manualAdjusted: true,
      };
    }
    throw new Error(`项目 ${item.item_name} 需要输入本次实际金额`);
  }

  if (preferredSource === "manual") {
    if (!manualUnitPrice || manualUnitPrice <= 0) {
      throw new Error(`项目 ${item.item_name} 需要输入本次实际金额`);
    }
    return {
      basis: "original_price",
      unitSource: "manual",
      unitPrice: manualUnitPrice,
      manualAdjusted: true,
    };
  }

  if (share.isValidNumber) {
    return {
      basis: "share_price",
      unitSource: "share",
      unitPrice: share.amount,
      manualAdjusted: false,
    };
  }

  if (original.isValidNumber) {
    return {
      basis: "original_price",
      unitSource: "original",
      unitPrice: original.amount,
      manualAdjusted: false,
    };
  }

  if (!manualUnitPrice || manualUnitPrice <= 0) {
    throw new Error(`项目 ${item.item_name} 需要输入本次实际金额`);
  }

  return {
    basis: "original_price",
    unitSource: "manual",
    unitPrice: manualUnitPrice,
    manualAdjusted: true,
  };
}

export function getDiscountRate(balanceBefore: number, tiers?: DiscountTier[]) {
  const targetTiers = (tiers && tiers.length > 0 ? tiers : DEFAULT_TIERS).slice();
  targetTiers.sort((a, b) => b.threshold - a.threshold);
  for (const tier of targetTiers) {
    if (balanceBefore >= tier.threshold) {
      return tier.rate;
    }
  }
  return 1;
}

export function getDiscountRateByTopupAmount(topupAmount: number, tiers?: DiscountTier[]) {
  if (!Number.isFinite(topupAmount) || topupAmount <= 0) {
    return 1;
  }
  return getDiscountRate(topupAmount, tiers);
}

export function getLockedDiscountRateFromTransactions(
  memberId: string,
  memberBalance: number,
  transactions: TransactionRecord[],
  tiers?: DiscountTier[],
  pendingTopupAmount = 0,
  manualLockedRate?: number,
) {
  const balanceAfterTopup = Math.max(memberBalance, 0) + Math.max(pendingTopupAmount, 0);
  if (balanceAfterTopup <= 0) {
    return 1;
  }

  const memberTxns = transactions
    .filter((row) => row.member_id === memberId)
    .slice()
    .sort((a, b) => {
      if (a.created_at === b.created_at) {
        return a.txn_id.localeCompare(b.txn_id);
      }
      return a.created_at < b.created_at ? -1 : 1;
    });

  let cycleRate: number | null = null;
  memberTxns.forEach((row) => {
    if (row.txn_type === "TOPUP" && row.net_amount > 0) {
      const topupRate = getDiscountRateByTopupAmount(row.net_amount, tiers);
      cycleRate = cycleRate === null ? topupRate : Math.min(cycleRate, topupRate);
    }
    if (row.txn_type === "SPEND" && row.balance_after > 0 && row.discount_rate > 0) {
      cycleRate = cycleRate === null ? row.discount_rate : Math.min(cycleRate, row.discount_rate);
    }
    if (row.txn_type === "SPEND" && row.balance_after <= 0) {
      cycleRate = null;
    }
  });

  const pendingRate = pendingTopupAmount > 0 ? getDiscountRateByTopupAmount(pendingTopupAmount, tiers) : null;
  const manualRate = Number(manualLockedRate);
  const hasManualRate = Number.isFinite(manualRate) && manualRate > 0 && manualRate <= 1;

  // 先尊重会员管理手动设置的当前档位（余额>0时生效）。
  // 先不做“充值自动变档”，由店员手工维护。
  if (memberBalance > 0 && hasManualRate) {
    return manualRate;
  }

  if (cycleRate !== null) {
    if (pendingRate !== null) {
      return Math.min(cycleRate, pendingRate);
    }
    return cycleRate;
  }

  if (pendingRate !== null) {
    return pendingRate;
  }

  // 兜底：历史老数据没有充值流水时，仍可按当前余额档位计算。
  return getDiscountRate(balanceAfterTopup, tiers);
}

export function normalizeRoundingMode(mode: string | undefined): RoundingMode {
  const upper = (mode ?? "ROUND").toUpperCase();
  if (upper === "CEIL" || upper === "UP" || upper === "向上") {
    return "CEIL";
  }
  if (upper === "FLOOR" || upper === "DOWN" || upper === "向下") {
    return "FLOOR";
  }
  return "ROUND";
}

export function roundAmount(value: number, unit = 1, mode: RoundingMode = "ROUND") {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const validUnit = unit > 0 ? unit : 1;
  const scaled = value / validUnit;

  if (mode === "CEIL") {
    return Math.ceil(scaled) * validUnit;
  }
  if (mode === "FLOOR") {
    return Math.floor(scaled) * validUnit;
  }
  return Math.round(scaled) * validUnit;
}

export function parseConfigRows(rows: Array<Record<string, string | number>>): ConfigRules {
  const map = new Map<string, string>();
  rows.forEach((row) => {
    const key = String(row.key ?? "").trim();
    const value = String(row.value ?? "").trim();
    if (key) {
      map.set(key, value);
    }
  });

  const tiers: DiscountTier[] = [
    {
      threshold: Number(map.get("discount_threshold_10000") ?? 10000),
      rate: Number(map.get("discount_rate_10000") ?? 0.75),
    },
    {
      threshold: Number(map.get("discount_threshold_5000") ?? 5000),
      rate: Number(map.get("discount_rate_5000") ?? 0.8),
    },
    {
      threshold: Number(map.get("discount_threshold_3000") ?? 3000),
      rate: Number(map.get("discount_rate_3000") ?? 0.85),
    },
    {
      threshold: Number(map.get("discount_threshold_1500") ?? 1500),
      rate: Number(map.get("discount_rate_1500") ?? 0.9),
    },
  ].filter(
    (tier) =>
      Number.isFinite(tier.threshold) &&
      Number.isFinite(tier.rate) &&
      tier.threshold > 0 &&
      tier.rate > 0 &&
      tier.rate <= 1,
  );

  const roundingMode = normalizeRoundingMode(map.get("rounding_mode"));
  const roundingUnit = Number(map.get("rounding_unit") ?? 1) || 1;
  const methodsRaw = map.get("allowed_payment_methods") ?? "BALANCE";
  const allowedPaymentMethods = methodsRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.toUpperCase() === "BALANCE" ? "BALANCE" : "BALANCE")) as Array<"BALANCE">;

  const quickAmounts = (map.get("topup_quick_amounts") ?? "1500,3000,5000,10000")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.round(item));
  const uniqueQuickAmounts = Array.from(new Set(quickAmounts)).sort((a, b) => a - b);
  const rawCurrency = String(map.get("currency_code") ?? "HKD").toUpperCase();
  const currencySet = new Set<CurrencyCode>(["HKD", "CNY", "USD", "EUR", "GBP", "JPY", "SGD", "AUD"]);
  const currencyCode = (currencySet.has(rawCurrency as CurrencyCode) ? rawCurrency : "HKD") as CurrencyCode;

  return {
    discountTiers: tiers.length > 0 ? tiers : DEFAULT_TIERS,
    topupQuickAmounts: uniqueQuickAmounts.length > 0 ? uniqueQuickAmounts : [1500, 3000, 5000, 10000],
    currencyCode,
    roundingMode,
    roundingUnit,
    allowedPaymentMethods: allowedPaymentMethods.length > 0 ? allowedPaymentMethods : ["BALANCE"],
  };
}

export function computeOrderAmounts(
  lineItems: TransactionLineItem[],
  discountRate: number,
) {
  const grossAmount = lineItems.reduce((sum, item) => sum + item.line_amount, 0);
  // 先保留折后原始值，小数统一在结算阶段处理（先 floor，再额外优惠）。
  const netAmount = grossAmount * discountRate;
  return { grossAmount, netAmount };
}

export interface PaymentSettlementInput {
  memberDeductAmount: number;
  externalPayAmount: number;
  extraDiscountAmount?: number;
  applyFloorDiscount?: boolean;
}

export interface PaymentSettlementResult {
  memberDeductAmount: number;
  externalPayAmount: number;
  totalPayableAmount: number;
  extraDiscountApplied: number;
  floorDiscountApplied: number;
  hasFloorDiscount: boolean;
}

export function settlePayableWithExtraDiscount(
  input: PaymentSettlementInput,
): PaymentSettlementResult {
  const memberBeforeAdjust = Math.max(input.memberDeductAmount, 0);
  const externalBeforeAdjust = Math.max(input.externalPayAmount, 0);
  const totalBeforeFloor = memberBeforeAdjust + externalBeforeAdjust;
  const shouldApplyFloor = Boolean(input.applyFloorDiscount);

  // Step 1: optional floor first.
  const totalAfterFloor = shouldApplyFloor ? Math.floor(totalBeforeFloor) : totalBeforeFloor;
  const floorDiscountApplied = shouldApplyFloor ? Math.max(totalBeforeFloor - totalAfterFloor, 0) : 0;

  let memberDeduct = memberBeforeAdjust;
  let externalPay = externalBeforeAdjust;
  if (floorDiscountApplied > 0) {
    const floorCutExternal = Math.min(externalPay, floorDiscountApplied);
    externalPay -= floorCutExternal;
    const remaining = floorDiscountApplied - floorCutExternal;
    if (remaining > 0) {
      memberDeduct = Math.max(memberDeduct - remaining, 0);
    }
  }

  // Step 2: manual extra discount after floor.
  const extraInput = Math.floor(Math.max(input.extraDiscountAmount ?? 0, 0));
  const beforeExtra = memberDeduct + externalPay;
  const extraDiscountApplied = Math.min(extraInput, beforeExtra);
  if (extraDiscountApplied > 0) {
    const cutExternal = Math.min(externalPay, extraDiscountApplied);
    externalPay -= cutExternal;
    const remain = extraDiscountApplied - cutExternal;
    if (remain > 0) {
      memberDeduct = Math.max(memberDeduct - remain, 0);
    }
  }

  const totalPayableAmount = Math.max(memberDeduct + externalPay, 0);

  return {
    memberDeductAmount: memberDeduct,
    externalPayAmount: externalPay,
    totalPayableAmount,
    extraDiscountApplied,
    floorDiscountApplied,
    hasFloorDiscount: floorDiscountApplied > 0.0001,
  };
}
