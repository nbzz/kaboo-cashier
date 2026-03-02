import {
  appendTransactionsLocal,
  getTransactionByIdLocal,
  getTransactionsLocal,
  findTransactionsByRequestIdLocal,
  getConfigLocal,
  getMemberByIdLocal,
  patchTransactionLocal,
  getPriceListLocal,
  updateMemberBalanceLocal,
} from "@/lib/local-db";
import {
  computeOrderAmounts,
  getLockedDiscountRateFromTransactions,
  resolveLinePrice,
  settlePayableWithExtraDiscount,
} from "@/lib/pricing";
import { nowHongKong } from "@/lib/time";
import type { SourceDevice, TransactionLineItem, TransactionRecord } from "@/lib/types";

interface CheckoutItemInput {
  item_id: string;
  quantity: number;
  manual_unit_price?: number;
  price_choice?: "SHARE" | "ORIGINAL" | "MANUAL";
}

interface CheckoutInput {
  request_id: string;
  member_id?: string;
  items: CheckoutItemInput[];
  topup_amount: number;
  guest_gender?: "女" | "男";
  extra_discount_amount?: number;
  apply_floor_discount?: boolean;
  notes?: string;
  discount_reason?: string;
  source_device: SourceDevice;
}

interface TopupInput {
  request_id: string;
  member_id: string;
  amount: number;
  notes?: string;
  source_device: SourceDevice;
}

interface ReversalInput {
  txn_id: string;
  request_id: string;
  source_device: SourceDevice;
}

function sortRecordsForResult(records: TransactionRecord[]) {
  return records.slice().sort((a, b) => {
    if (a.created_at === b.created_at) {
      if (a.txn_type === b.txn_type) {
        return a.txn_id.localeCompare(b.txn_id);
      }
      return a.txn_type === "TOPUP" ? -1 : 1;
    }
    return a.created_at < b.created_at ? -1 : 1;
  });
}

function buildTransactionBase(
  requestId: string,
  memberId: string,
  memberName: string,
  sourceDevice: SourceDevice,
) {
  const now = nowHongKong();
  return {
    request_id: requestId,
    created_at: now.createdAt,
    biz_date: now.bizDate,
    biz_time: now.bizTime,
    member_id: memberId,
    member_name_snapshot: memberName,
    source_device: sourceDevice,
  };
}

function normalizeGender(input?: string) {
  if (input === "男") return "男";
  if (input === "女") return "女";
  return undefined;
}

export async function executeTopupLocal(payload: TopupInput) {
  const existing = await findTransactionsByRequestIdLocal(payload.request_id);
  if (existing.length > 0) {
    return { alreadyProcessed: true, records: sortRecordsForResult(existing) };
  }

  if (payload.amount <= 0) {
    throw new Error("充值金額必須大於 0");
  }

  const member = await getMemberByIdLocal(payload.member_id);
  if (!member) {
    throw new Error("找不到會員");
  }

  const before = member.balance;
  const after = before + payload.amount;
  const base = buildTransactionBase(
    payload.request_id,
    member.member_id,
    member.name,
    payload.source_device,
  );

  const record: TransactionRecord = {
    txn_id: crypto.randomUUID(),
    ...base,
    txn_type: "TOPUP",
    items_json: "",
    customer_gender: normalizeGender(member.gender),
    gross_amount: payload.amount,
    discount_rate: 1,
    net_amount: payload.amount,
    external_pay_amount: 0,
    settlement_mode: "TOPUP",
    pricing_basis: "share_price",
    manual_price_adjusted: false,
    payment_method: "BALANCE",
    balance_before: before,
    balance_after: after,
    notes: payload.notes ?? "",
    discount_reason: "",
  };

  await appendTransactionsLocal([record]);
  await updateMemberBalanceLocal(member.member_id, after, nowHongKong().createdAt);

  return { alreadyProcessed: false, records: [record] };
}

export async function executeCheckoutLocal(payload: CheckoutInput) {
  const existing = await findTransactionsByRequestIdLocal(payload.request_id);
  if (existing.length > 0) {
    return { alreadyProcessed: true, records: sortRecordsForResult(existing) };
  }

  const [member, config, priceList, transactions] = await Promise.all([
    payload.member_id ? getMemberByIdLocal(payload.member_id) : Promise.resolve(null),
    getConfigLocal(),
    getPriceListLocal(),
    getTransactionsLocal(),
  ]);

  if (payload.member_id && !member) {
    throw new Error("找不到會員");
  }
  const isMemberCheckout = Boolean(member);
  if (!isMemberCheckout && payload.topup_amount > 0) {
    throw new Error("非會員流水不可充值");
  }
  const customerGender = normalizeGender(
    isMemberCheckout ? member?.gender : payload.guest_gender,
  );
  const memberId = member?.member_id ?? "";
  const memberName = member?.name ?? "散客";

  const activePriceMap = new Map(
    priceList.filter((item) => item.active).map((item) => [item.item_id, item]),
  );

  const lineItems: TransactionLineItem[] = payload.items.map((input) => {
    const item = activePriceMap.get(input.item_id);
    if (!item) {
      throw new Error("項目不存在或已停用");
    }

    const preferredSource = isMemberCheckout
      ? input.price_choice === "SHARE"
        ? "share"
        : input.price_choice === "ORIGINAL"
          ? "original"
          : input.price_choice === "MANUAL"
            ? "manual"
            : undefined
      : input.price_choice === "MANUAL"
        ? "manual"
        : "original";
    const resolved = resolveLinePrice(item, input.manual_unit_price, preferredSource);
    const quantity = input.quantity > 0 ? input.quantity : 1;
    return {
      item_id: item.item_id,
      item_name: item.item_name,
      category: item.category,
      quantity,
      unit_source: resolved.unitSource,
      unit_price: resolved.unitPrice,
      line_amount: resolved.unitPrice * quantity,
      manual_input: resolved.manualAdjusted,
    };
  });

  const records: TransactionRecord[] = [];
  let workingBalance = member?.balance ?? 0;
  const base = buildTransactionBase(
    payload.request_id,
    memberId,
    memberName,
    payload.source_device,
  );

  if (isMemberCheckout && payload.topup_amount > 0) {
    const topupBefore = workingBalance;
    const topupAfter = topupBefore + payload.topup_amount;
    records.push({
      txn_id: crypto.randomUUID(),
      ...base,
      txn_type: "TOPUP",
      items_json: "",
      customer_gender: customerGender,
      gross_amount: payload.topup_amount,
      discount_rate: 1,
      net_amount: payload.topup_amount,
      external_pay_amount: 0,
      settlement_mode: "TOPUP",
      pricing_basis: "share_price",
      manual_price_adjusted: false,
      payment_method: "BALANCE",
      balance_before: topupBefore,
      balance_after: topupAfter,
      notes: payload.notes ?? "",
      discount_reason: "",
    });
    workingBalance = topupAfter;
  }

  const discountRate = isMemberCheckout
    ? getLockedDiscountRateFromTransactions(
        memberId,
        member?.balance ?? 0,
        transactions,
        config.discountTiers,
        payload.topup_amount,
        member?.manual_locked_discount_rate,
      )
    : 1;
  const { grossAmount, netAmount } = computeOrderAmounts(lineItems, discountRate);

  const extraDiscountInput = Math.max(payload.extra_discount_amount ?? 0, 0);
  let memberDeductAmount = isMemberCheckout ? netAmount : 0;
  let externalPayAmount = isMemberCheckout ? 0 : netAmount;
  let settlementMode: TransactionRecord["settlement_mode"] = isMemberCheckout
    ? "FULL_BALANCE"
    : "WALKIN_ORIGINAL";

  if (isMemberCheckout && workingBalance < netAmount) {
    const safeRate = discountRate > 0 ? discountRate : 1;
    const grossCoveredByBalance = workingBalance / safeRate;
    const remainingGross = Math.max(grossAmount - grossCoveredByBalance, 0);
    memberDeductAmount = workingBalance;
    externalPayAmount = remainingGross;
    settlementMode = "PARTIAL_BALANCE";
  }

  const settled = settlePayableWithExtraDiscount({
    memberDeductAmount,
    externalPayAmount,
    extraDiscountAmount: extraDiscountInput,
    applyFloorDiscount: isMemberCheckout ? Boolean(payload.apply_floor_discount) : true,
  });
  memberDeductAmount = settled.memberDeductAmount;
  externalPayAmount = settled.externalPayAmount;

  const spendBefore = isMemberCheckout ? workingBalance : 0;
  const spendAfter = isMemberCheckout ? Math.max(spendBefore - memberDeductAmount, 0) : 0;
  const discountReasonParts = [payload.discount_reason ?? ""];
  if (settled.extraDiscountApplied > 0) {
    discountReasonParts.push(`EXTRA_DISCOUNT:${settled.extraDiscountApplied.toFixed(2)}`);
  }
  if (settled.floorDiscountApplied > 0) {
    discountReasonParts.push(`FLOOR_ADJUST:${settled.floorDiscountApplied.toFixed(2)}`);
  }
  records.push({
    txn_id: crypto.randomUUID(),
    ...base,
    txn_type: "SPEND",
    items_json: JSON.stringify(lineItems),
    customer_gender: customerGender,
    gross_amount: grossAmount,
    discount_rate: discountRate,
    net_amount: memberDeductAmount,
    external_pay_amount: externalPayAmount,
    extra_discount_amount: settled.extraDiscountApplied,
    floor_discount_amount: settled.floorDiscountApplied,
    settlement_mode: settlementMode,
    pricing_basis: lineItems.every((item) => item.unit_source === "share")
      ? "share_price"
      : "original_price",
    manual_price_adjusted: lineItems.some((item) => item.manual_input),
    payment_method: "BALANCE",
    balance_before: spendBefore,
    balance_after: spendAfter,
    notes: payload.notes ?? "",
    discount_reason: discountReasonParts.filter(Boolean).join(" | "),
  });

  await appendTransactionsLocal(records);
  if (isMemberCheckout && member) {
    await updateMemberBalanceLocal(member.member_id, spendAfter, nowHongKong().createdAt);
  }

  return {
    alreadyProcessed: false,
    records: sortRecordsForResult(records),
    preview: {
      member_name: memberName,
      balance_before: member?.balance ?? 0,
      balance_after: spendAfter,
      gross_amount: grossAmount,
      net_amount: memberDeductAmount,
      external_pay_amount: externalPayAmount,
      extra_discount_amount: settled.extraDiscountApplied,
      floor_discount_amount: settled.floorDiscountApplied,
      floor_discount_applied: settled.hasFloorDiscount,
      settlement_mode: settlementMode,
      discount_rate: discountRate,
      line_items: lineItems,
    },
  };
}

export async function executeReversalLocal(payload: ReversalInput) {
  const existing = await findTransactionsByRequestIdLocal(payload.request_id);
  if (existing.length > 0) {
    return { alreadyProcessed: true, records: sortRecordsForResult(existing) };
  }

  const target = await getTransactionByIdLocal(payload.txn_id);
  if (!target) {
    throw new Error("找不到要撤回的流水");
  }
  if (target.reversal_of_txn_id) {
    throw new Error("沖正單不可再次撤回");
  }
  if (target.reversed_by_txn_id) {
    throw new Error("這筆流水已撤回");
  }

  if (!target.member_id) {
    if (target.txn_type !== "SPEND") {
      throw new Error("散客僅支持撤回消費流水");
    }
    const base = buildTransactionBase(
      payload.request_id,
      "",
      target.member_name_snapshot || "散客",
      payload.source_device,
    );
    const reversalRecord: TransactionRecord = {
      txn_id: crypto.randomUUID(),
      ...base,
      txn_type: "SPEND",
      items_json: "",
      customer_gender: normalizeGender(target.customer_gender),
      gross_amount: -Math.abs(target.gross_amount),
      discount_rate: target.discount_rate > 0 ? target.discount_rate : 1,
      net_amount: -Math.abs(target.net_amount),
      external_pay_amount: -Math.abs(target.external_pay_amount ?? 0),
      settlement_mode: "WALKIN_ORIGINAL",
      pricing_basis: target.pricing_basis,
      manual_price_adjusted: false,
      payment_method: "BALANCE",
      balance_before: 0,
      balance_after: 0,
      notes: `[撤回] 沖正散客消費 ${target.txn_id}`,
      discount_reason: "REVERSAL",
      source_device: payload.source_device,
      reversal_of_txn_id: target.txn_id,
    };
    await appendTransactionsLocal([reversalRecord]);
    await patchTransactionLocal(target.txn_id, {
      reversed_by_txn_id: reversalRecord.txn_id,
      notes: target.notes ? `${target.notes} ｜ 已撤回` : "已撤回",
    });
    return {
      alreadyProcessed: false,
      records: [reversalRecord],
    };
  }

  const [member, allTransactions] = await Promise.all([
    getMemberByIdLocal(target.member_id),
    getTransactionsLocal(),
  ]);

  if (!member) {
    throw new Error("找不到會員，無法撤回");
  }

  const latestMemberTxn = allTransactions.find((row) => row.member_id === target.member_id);
  if (!latestMemberTxn || latestMemberTxn.txn_id !== target.txn_id) {
    throw new Error("只能撤回該會員最近一筆流水");
  }

  const base = buildTransactionBase(
    payload.request_id,
    member.member_id,
    member.name,
    payload.source_device,
  );

  let reversalRecord: TransactionRecord;
  if (target.txn_type === "SPEND") {
    const before = member.balance;
    const after = before + target.net_amount;
    reversalRecord = {
      txn_id: crypto.randomUUID(),
      ...base,
      txn_type: "TOPUP",
      items_json: "",
      customer_gender: normalizeGender(target.customer_gender),
      gross_amount: target.net_amount,
      discount_rate: 1,
      net_amount: target.net_amount,
      external_pay_amount: 0,
      settlement_mode: "TOPUP",
      pricing_basis: target.pricing_basis,
      manual_price_adjusted: false,
      payment_method: "BALANCE",
      balance_before: before,
      balance_after: after,
      notes: `[撤回] 沖正消費 ${target.txn_id}`,
      discount_reason: "REVERSAL",
      source_device: payload.source_device,
      reversal_of_txn_id: target.txn_id,
    };
    await appendTransactionsLocal([reversalRecord]);
    await patchTransactionLocal(target.txn_id, {
      reversed_by_txn_id: reversalRecord.txn_id,
      notes: target.notes ? `${target.notes} ｜ 已撤回` : "已撤回",
    });
    await updateMemberBalanceLocal(member.member_id, after, nowHongKong().createdAt);
  } else {
    if (member.balance < target.net_amount) {
      throw new Error("會員當前餘額不足，無法撤回該充值");
    }
    const before = member.balance;
    const after = before - target.net_amount;
    reversalRecord = {
      txn_id: crypto.randomUUID(),
      ...base,
      txn_type: "SPEND",
      items_json: "",
      customer_gender: normalizeGender(target.customer_gender),
      gross_amount: target.net_amount,
      discount_rate: 1,
      net_amount: target.net_amount,
      external_pay_amount: 0,
      settlement_mode: "FULL_BALANCE",
      pricing_basis: target.pricing_basis,
      manual_price_adjusted: false,
      payment_method: "BALANCE",
      balance_before: before,
      balance_after: after,
      notes: `[撤回] 沖正充值 ${target.txn_id}`,
      discount_reason: "REVERSAL",
      source_device: payload.source_device,
      reversal_of_txn_id: target.txn_id,
    };
    await appendTransactionsLocal([reversalRecord]);
    await patchTransactionLocal(target.txn_id, {
      reversed_by_txn_id: reversalRecord.txn_id,
      notes: target.notes ? `${target.notes} ｜ 已撤回` : "已撤回",
    });
    await updateMemberBalanceLocal(member.member_id, after, nowHongKong().createdAt);
  }

  return {
    alreadyProcessed: false,
    records: [reversalRecord],
  };
}
