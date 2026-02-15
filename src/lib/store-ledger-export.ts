import { filterTransactionsByRange, type AnalysisRange } from "@/lib/analytics";
import { getTransactionsLocal } from "@/lib/local-db";
import { nowHongKong } from "@/lib/time";
import type { TransactionLineItem, TransactionRecord } from "@/lib/types";
import * as XLSX from "xlsx";

interface ParsedItem {
  category: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  lineAmount: number;
}

const RANGE_LABEL: Record<AnalysisRange, string> = {
  WEEK: "本周",
  "30D": "最近30天",
  QUARTER: "最近一季度",
  "365D": "最近365天",
  ALL: "所有",
};

function parseItems(row: TransactionRecord) {
  if (!row.items_json) {
    return [] as ParsedItem[];
  }
  try {
    const raw = JSON.parse(row.items_json) as TransactionLineItem[];
    if (!Array.isArray(raw)) return [] as ParsedItem[];
    return raw.map((item) => {
      const quantity = Number(item.quantity || 1);
      const lineAmount = Number(item.line_amount || 0);
      const unitPrice = Number(item.unit_price || 0);
      return {
        category: item.category || "未分類",
        itemName: item.item_name || item.item_id || "未命名項目",
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        lineAmount: Number.isFinite(lineAmount) && lineAmount >= 0 ? lineAmount : 0,
        unitPrice: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
      };
    });
  } catch {
    return [] as ParsedItem[];
  }
}

function transactionItemSummary(row: TransactionRecord) {
  if (row.txn_type === "TOPUP") return "會員充值";
  const items = parseItems(row);
  if (items.length === 0) return "—";
  return items.map((item) => `${item.category}｜${item.itemName} x${item.quantity}`).join("、");
}

function sortByBizDateDesc(rows: TransactionRecord[]) {
  return rows.slice().sort((a, b) => {
    if (a.biz_date === b.biz_date) {
      if (a.biz_time === b.biz_time) return b.txn_id.localeCompare(a.txn_id);
      return a.biz_time < b.biz_time ? 1 : -1;
    }
    return a.biz_date < b.biz_date ? 1 : -1;
  });
}

function splitSpendAmountByItem(
  row: TransactionRecord,
  items: ParsedItem[],
) {
  const totalLineAmount = items.reduce((sum, item) => sum + item.lineAmount, 0);
  const memberTotal = Math.max(0, row.net_amount);
  const externalTotal = Math.max(0, row.external_pay_amount ?? 0);
  if (items.length === 0 || totalLineAmount <= 0) {
    return [] as Array<{ memberDeduct: number; externalPay: number; payable: number }>;
  }

  const result = items.map((item) => {
    const ratio = item.lineAmount / totalLineAmount;
    return {
      memberDeduct: memberTotal * ratio,
      externalPay: externalTotal * ratio,
      payable: (memberTotal + externalTotal) * ratio,
    };
  });

  // 把四舍五入误差压到最后一行，保证总和精确
  const sumMember = result.reduce((sum, item) => sum + item.memberDeduct, 0);
  const sumExternal = result.reduce((sum, item) => sum + item.externalPay, 0);
  const sumPayable = result.reduce((sum, item) => sum + item.payable, 0);
  const last = result[result.length - 1];
  last.memberDeduct += memberTotal - sumMember;
  last.externalPay += externalTotal - sumExternal;
  last.payable += memberTotal + externalTotal - sumPayable;
  return result;
}

export async function buildStoreLedgerWorkbook(range: AnalysisRange) {
  const allTransactions = await getTransactionsLocal();
  const ranged = filterTransactionsByRange(allTransactions, range);
  const rows = sortByBizDateDesc(ranged);
  const workbook = XLSX.utils.book_new();
  const rangeLabel = RANGE_LABEL[range];
  const exportDate = nowHongKong().bizDate;

  const overviewAoA: Array<Array<string | number>> = [
    ["店鋪流水簡版"],
    [`範圍：${rangeLabel}`],
    [`導出日期：${exportDate}`],
    [],
    [
      "日期",
      "時間",
      "交易類型",
      "會員/散客",
      "項目摘要",
      "本單應收(HKD)",
      "充值入賬(HKD)",
      "會員扣款(HKD)",
      "餘額外另收(HKD)",
      "額外優惠(HKD)",
      "去小數優惠(HKD)",
      "餘額變化",
      "備註",
    ],
  ];

  rows.forEach((row) => {
    const payable = row.net_amount + (row.external_pay_amount ?? 0);
    overviewAoA.push([
      row.biz_date,
      row.biz_time,
      row.txn_type === "TOPUP" ? "充值" : "消費",
      row.member_name_snapshot || "散客",
      transactionItemSummary(row),
      Number(payable.toFixed(2)),
      Number((row.txn_type === "TOPUP" ? row.net_amount : 0).toFixed(2)),
      Number((row.txn_type === "SPEND" ? row.net_amount : 0).toFixed(2)),
      Number((row.external_pay_amount ?? 0).toFixed(2)),
      Number((row.extra_discount_amount ?? 0).toFixed(2)),
      Number((row.floor_discount_amount ?? 0).toFixed(2)),
      `${row.balance_before.toFixed(0)} → ${row.balance_after.toFixed(0)}`,
      row.notes || "",
    ]);
  });

  if (rows.length === 0) {
    overviewAoA.push(["—", "—", "—", "—", "暫無數據"]);
  }

  const overviewSheet = XLSX.utils.aoa_to_sheet(overviewAoA);
  overviewSheet["!cols"] = [
    { wch: 12 },
    { wch: 8 },
    { wch: 10 },
    { wch: 14 },
    { wch: 42 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 28 },
    { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(workbook, overviewSheet, "店鋪流水簡版");

  const detailAoA: Array<Array<string | number>> = [
    ["消費明細（按項目拆分）"],
    [`範圍：${rangeLabel}`],
    [`導出日期：${exportDate}`],
    [],
    [
      "日期",
      "時間",
      "會員/散客",
      "分類",
      "項目",
      "數量",
      "單價(HKD)",
      "小計(HKD)",
      "折扣(%)",
      "會員實扣(HKD)",
      "餘額外原價(HKD)",
      "額外優惠(HKD)",
      "去小數優惠(HKD)",
      "本項應收(HKD)",
      "備註",
      "流水號",
    ],
  ];

  rows
    .filter((row) => row.txn_type === "SPEND")
    .forEach((row) => {
      const items = parseItems(row);
      if (items.length === 0) {
        detailAoA.push([
          row.biz_date,
          row.biz_time,
          row.member_name_snapshot || "散客",
          "未分類",
          "未解析項目",
          1,
          Number(row.gross_amount.toFixed(2)),
          Number(row.gross_amount.toFixed(2)),
          Number((row.discount_rate * 100).toFixed(2)),
          Number(row.net_amount.toFixed(2)),
          Number((row.external_pay_amount ?? 0).toFixed(2)),
          Number((row.extra_discount_amount ?? 0).toFixed(2)),
          Number((row.floor_discount_amount ?? 0).toFixed(2)),
          Number((row.net_amount + (row.external_pay_amount ?? 0)).toFixed(2)),
          row.notes || "",
          row.txn_id,
        ]);
        return;
      }

      const split = splitSpendAmountByItem(row, items);
      items.forEach((item, index) => {
        detailAoA.push([
          row.biz_date,
          row.biz_time,
          row.member_name_snapshot || "散客",
          item.category,
          item.itemName,
          item.quantity,
          Number(item.unitPrice.toFixed(2)),
          Number(item.lineAmount.toFixed(2)),
          Number((row.discount_rate * 100).toFixed(2)),
          Number((split[index]?.memberDeduct ?? 0).toFixed(2)),
          Number((split[index]?.externalPay ?? 0).toFixed(2)),
          index === items.length - 1 ? Number((row.extra_discount_amount ?? 0).toFixed(2)) : 0,
          index === items.length - 1 ? Number((row.floor_discount_amount ?? 0).toFixed(2)) : 0,
          Number((split[index]?.payable ?? 0).toFixed(2)),
          row.notes || "",
          row.txn_id,
        ]);
      });
    });

  if (detailAoA.length === 5) {
    detailAoA.push(["—", "—", "—", "—", "—", "暫無消費明細"]);
  }

  const detailSheet = XLSX.utils.aoa_to_sheet(detailAoA);
  detailSheet["!cols"] = [
    { wch: 12 },
    { wch: 8 },
    { wch: 14 },
    { wch: 20 },
    { wch: 24 },
    { wch: 8 },
    { wch: 12 },
    { wch: 12 },
    { wch: 10 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 24 },
    { wch: 38 },
  ];
  XLSX.utils.book_append_sheet(workbook, detailSheet, "消費明細");

  const dailyMap = new Map<string, {
    topupAmount: number;
    spendMember: number;
    spendExternal: number;
    spendPayable: number;
    topupCount: number;
    spendCount: number;
  }>();

  rows.forEach((row) => {
    const key = row.biz_date;
    const current = dailyMap.get(key) ?? {
      topupAmount: 0,
      spendMember: 0,
      spendExternal: 0,
      spendPayable: 0,
      topupCount: 0,
      spendCount: 0,
    };
    if (row.txn_type === "TOPUP") {
      current.topupAmount += row.net_amount;
      current.topupCount += 1;
    } else {
      current.spendMember += row.net_amount;
      current.spendExternal += row.external_pay_amount ?? 0;
      current.spendPayable += row.net_amount + (row.external_pay_amount ?? 0);
      current.spendCount += 1;
    }
    dailyMap.set(key, current);
  });

  const dailyAoA: Array<Array<string | number>> = [
    ["每日彙總"],
    [`範圍：${rangeLabel}`],
    [`導出日期：${exportDate}`],
    [],
    [
      "日期",
      "充值筆數",
      "消費筆數",
      "充值總額(HKD)",
      "會員扣款(HKD)",
      "餘額外另收(HKD)",
      "本期服務應收(HKD)",
      "儲值池變化(充值-會員扣款)(HKD)",
      "即時現金流入(充值+另收)(HKD)",
    ],
  ];

  Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([date, item]) => {
      dailyAoA.push([
        date,
        item.topupCount,
        item.spendCount,
        Number(item.topupAmount.toFixed(2)),
        Number(item.spendMember.toFixed(2)),
        Number(item.spendExternal.toFixed(2)),
        Number(item.spendPayable.toFixed(2)),
        Number((item.topupAmount - item.spendMember).toFixed(2)),
        Number((item.topupAmount + item.spendExternal).toFixed(2)),
      ]);
    });

  if (dailyAoA.length === 5) {
    dailyAoA.push(["—", 0, 0, 0, 0, 0, 0, 0, 0]);
  }

  const dailySheet = XLSX.utils.aoa_to_sheet(dailyAoA);
  dailySheet["!cols"] = [
    { wch: 14 },
    { wch: 10 },
    { wch: 10 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 22 },
    { wch: 22 },
    { wch: 22 },
  ];
  XLSX.utils.book_append_sheet(workbook, dailySheet, "每日彙總");

  const fileName = `店鋪流水_${rangeLabel}_${exportDate}.xlsx`;
  return {
    workbook,
    exportDate,
    fileName,
  };
}

export async function exportStoreLedgerWorkbookBase64(range: AnalysisRange) {
  const { workbook } = await buildStoreLedgerWorkbook(range);
  return XLSX.write(workbook, { type: "base64", bookType: "xlsx" });
}

export async function exportStoreLedgerWorkbook(range: AnalysisRange) {
  const { workbook, fileName } = await buildStoreLedgerWorkbook(range);
  XLSX.writeFile(workbook, fileName);
}
