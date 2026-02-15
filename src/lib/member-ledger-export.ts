"use client";

import { buildMemberStats } from "@/lib/analytics";
import { getMembersLocal, getTransactionsLocal } from "@/lib/local-db";
import { getLockedDiscountRateFromTransactions } from "@/lib/pricing";
import { nowHongKong } from "@/lib/time";
import type { Member, TransactionLineItem, TransactionRecord } from "@/lib/types";
import * as XLSX from "xlsx";

function formatMoney(value: number) {
  return `HK$${Number(value || 0).toLocaleString("zh-HK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function safeSheetName(raw: string) {
  const cleaned = raw.replace(/[:\\/?*\[\]]/g, " ").trim();
  const fallback = cleaned || "會員";
  return fallback.slice(0, 31);
}

function buildUniqueSheetName(member: Member, used: Set<string>) {
  const base = safeSheetName(member.name);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let i = 2; i <= 999; i += 1) {
    const candidate = safeSheetName(`${base.slice(0, 27)}（${i}）`);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback = safeSheetName(`會員_${Date.now() % 10000}`);
  used.add(fallback);
  return fallback;
}

function rateToTierLabel(rate: number) {
  if (rate <= 0.75) return "75折";
  if (rate <= 0.8) return "8折";
  if (rate <= 0.85) return "85折";
  if (rate <= 0.9) return "9折";
  return "原價";
}

function parseItemSummary(row: TransactionRecord) {
  if (row.txn_type === "TOPUP") {
    return "會員充值";
  }
  if (!row.items_json) {
    return "—";
  }
  try {
    const items = JSON.parse(row.items_json) as TransactionLineItem[];
    if (!Array.isArray(items) || items.length === 0) {
      return "—";
    }
    return items
      .map((item) => `${item.category || "未分類"}｜${item.item_name} x${item.quantity || 1}`)
      .join("、");
  } catch {
    return "—";
  }
}

function sortTransactionsDesc(rows: TransactionRecord[]) {
  return rows.slice().sort((a, b) => {
    if (a.created_at === b.created_at) {
      return b.txn_id.localeCompare(a.txn_id);
    }
    return a.created_at < b.created_at ? 1 : -1;
  });
}

export async function buildMemberLedgerWorkbook() {
  const [members, transactions] = await Promise.all([
    getMembersLocal({ includeInactive: true, limit: 100000 }),
    getTransactionsLocal(),
  ]);

  const statsMap = buildMemberStats(members, transactions);
  const memberMap = new Map(members.map((member) => [member.member_id, member]));
  const workbook = XLSX.utils.book_new();
  const usedSheetNames = new Set<string>(["會員總覽"]);
  const memberSheetMap = new Map<string, string>();

  members.forEach((member) => {
    const sheetName = buildUniqueSheetName(member, usedSheetNames);
    memberSheetMap.set(member.member_id, sheetName);
  });

  const sortedMembers = members.slice().sort((a, b) => b.balance - a.balance);
  const summaryRows: Array<Array<string | number>> = [
    [`會員總覽（全部會員）`],
    [`導出日期：${nowHongKong().bizDate}`],
    [],
    [
      "查看流水",
      "序號",
      "姓名",
      "電話",
      "電郵",
      "會員檔位",
      "當前餘額(HKD)",
      "總充值(HKD)",
      "總消費(HKD)",
      "近30天消費(HKD)",
      "消費次數",
      "上次消費日期",
      "偏好項目",
      "會員狀態",
    ],
  ];

  sortedMembers.forEach((member, index) => {
    const stat = statsMap.get(member.member_id);
    const rate = getLockedDiscountRateFromTransactions(
      member.member_id,
      member.balance,
      transactions,
      undefined,
      0,
    );
    summaryRows.push([
      "查看流水",
      index + 1,
      member.name,
      member.phone,
      member.email || "—",
      rateToTierLabel(rate),
      Number(member.balance.toFixed(2)),
      Number((stat?.totalTopup ?? 0).toFixed(2)),
      Number((stat?.totalSpend ?? 0).toFixed(2)),
      Number((stat?.recent30Spend ?? 0).toFixed(2)),
      stat?.spendCount ?? 0,
      stat?.lastSpendAt ? stat.lastSpendAt.slice(0, 10) : "—",
      stat?.favoriteTop1 || "—",
      member.active ? "啟用" : "停用",
    ]);
  });

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!cols"] = [
    { wch: 12 },
    { wch: 6 },
    { wch: 14 },
    { wch: 12 },
    { wch: 20 },
    { wch: 10 },
    { wch: 24 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 10 },
    { wch: 14 },
    { wch: 18 },
  ];

  sortedMembers.forEach((member, index) => {
    const rowNo = 5 + index;
    const targetSheet = memberSheetMap.get(member.member_id);
    if (!targetSheet) {
      return;
    }
    const linkCell = `A${rowNo}`;
    if (!summarySheet[linkCell]) {
      summarySheet[linkCell] = { t: "s", v: "查看流水" };
    }
    summarySheet[linkCell].l = { Target: `#'${targetSheet}'!A1` };
  });

  XLSX.utils.book_append_sheet(workbook, summarySheet, "會員總覽");

  sortedMembers.forEach((member) => {
    const sheetName = memberSheetMap.get(member.member_id);
    if (!sheetName) {
      return;
    }

    const memberTxns = sortTransactionsDesc(
      transactions.filter((row) => row.member_id === member.member_id),
    );
    const stat = statsMap.get(member.member_id);
    const currentRate = getLockedDiscountRateFromTransactions(
      member.member_id,
      member.balance,
      transactions,
      undefined,
      0,
    );

    const rows: Array<Array<string | number>> = [
      ["← 返回會員總覽"],
      ["會員流水帳"],
      ["姓名", member.name, "會員檔位", rateToTierLabel(currentRate)],
      ["電話", member.phone, "電郵", member.email || "—"],
      ["當前餘額", formatMoney(member.balance), "狀態", member.active ? "啟用" : "停用"],
      ["總充值(HKD)", Number((stat?.totalTopup ?? 0).toFixed(2)), "總消費(HKD)", Number((stat?.totalSpend ?? 0).toFixed(2))],
      ["近30天消費(HKD)", Number((stat?.recent30Spend ?? 0).toFixed(2)), "偏好項目", stat?.favoriteTop1 || "—"],
      [],
      [
        "日期",
        "時間",
        "類型",
        "類型代碼",
        "項目摘要",
        "充值金額(HKD)",
        "折前金額(HKD)",
        "折扣(%)",
        "會員扣款(HKD)",
        "另收金額(HKD)",
        "本單應收(HKD)",
        "餘額前(HKD)",
        "餘額後(HKD)",
        "備註",
        "流水號",
      ],
    ];

    memberTxns.forEach((row) => {
      const isTopup = row.txn_type === "TOPUP";
      const payable = row.net_amount + (row.external_pay_amount ?? 0);
      rows.push([
        row.biz_date,
        row.biz_time,
        isTopup ? "🟢 充值" : "🟠 消費",
        isTopup ? "TOPUP" : "SPEND",
        parseItemSummary(row),
        isTopup ? Number(row.net_amount.toFixed(2)) : 0,
        isTopup ? 0 : Number(row.gross_amount.toFixed(2)),
        isTopup ? 0 : Number((row.discount_rate * 100).toFixed(2)),
        isTopup ? 0 : Number(row.net_amount.toFixed(2)),
        isTopup ? 0 : Number((row.external_pay_amount ?? 0).toFixed(2)),
        isTopup ? 0 : Number(payable.toFixed(2)),
        Number(row.balance_before.toFixed(2)),
        Number(row.balance_after.toFixed(2)),
        row.notes || "—",
        row.txn_id,
      ]);
    });

    if (memberTxns.length === 0) {
      rows.push(["—", "—", "—", "—", "暫無流水", 0, 0, 0, 0, 0, 0, Number(member.balance.toFixed(2)), Number(member.balance.toFixed(2)), "—", "—"]);
    }

    const memberSheet = XLSX.utils.aoa_to_sheet(rows);
    memberSheet["!cols"] = [
      { wch: 12 },
      { wch: 8 },
      { wch: 11 },
      { wch: 10 },
      { wch: 44 },
      { wch: 13 },
      { wch: 12 },
      { wch: 8 },
      { wch: 12 },
      { wch: 12 },
      { wch: 12 },
      { wch: 12 },
      { wch: 12 },
      { wch: 24 },
      { wch: 38 },
    ];
    if (!memberSheet.A1) {
      memberSheet.A1 = { t: "s", v: "← 返回會員總覽" };
    }
    memberSheet.A1.l = { Target: "#'會員總覽'!A1" };
    XLSX.utils.book_append_sheet(workbook, memberSheet, sheetName);
  });

  const memberTemplateRows: Array<Array<string | number>> = [
    [
      "姓名",
      "電話(唯一鍵)",
      "電郵",
      "餘額(HKD)",
      "性別",
      "生日(YYYY-MM-DD)",
      "卡號",
      "微信/WhatsApp",
      "註冊日期(YYYY-MM-DD)",
      "狀態(啟用/停用)",
      "備註",
    ],
    ...sortedMembers.map((member) => [
      member.name,
      member.phone,
      member.email || "",
      Number(member.balance.toFixed(2)),
      member.gender || "",
      member.birthday || "",
      member.card_no || "",
      member.wechat_or_whatsapp || "",
      member.register_date || "",
      member.active ? "啟用" : "停用",
      member.notes || "",
    ]),
  ];
  const memberTemplateSheet = XLSX.utils.aoa_to_sheet(memberTemplateRows);
  memberTemplateSheet["!cols"] = [
    { wch: 14 },
    { wch: 14 },
    { wch: 24 },
    { wch: 14 },
    { wch: 8 },
    { wch: 16 },
    { wch: 12 },
    { wch: 18 },
    { wch: 16 },
    { wch: 12 },
    { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(workbook, memberTemplateSheet, "導入模板_會員");

  const txnTemplateRows: Array<Array<string | number>> = [
    [
      "會員電話(可空=散客)",
      "日期(YYYY-MM-DD)",
      "時間(HH:mm)",
      "類型(TOPUP/SPEND)",
      "項目摘要",
      "折前金額(HKD)",
      "折扣(%)",
      "會員扣款(HKD)",
      "另收金額(HKD)",
      "餘額前(HKD)",
      "餘額後(HKD)",
      "備註",
    ],
  ];
  sortTransactionsDesc(transactions).forEach((row) => {
    const member = memberMap.get(row.member_id);
    txnTemplateRows.push([
      member?.phone || "",
      row.biz_date,
      row.biz_time,
      row.txn_type,
      parseItemSummary(row),
      Number(row.gross_amount.toFixed(2)),
      Number((row.discount_rate * 100).toFixed(2)),
      Number(row.net_amount.toFixed(2)),
      Number((row.external_pay_amount ?? 0).toFixed(2)),
      Number(row.balance_before.toFixed(2)),
      Number(row.balance_after.toFixed(2)),
      row.notes || "",
    ]);
  });
  const txnTemplateSheet = XLSX.utils.aoa_to_sheet(txnTemplateRows);
  txnTemplateSheet["!cols"] = [
    { wch: 18 },
    { wch: 14 },
    { wch: 10 },
    { wch: 16 },
    { wch: 42 },
    { wch: 14 },
    { wch: 10 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(workbook, txnTemplateSheet, "導入模板_流水");

  const exportDate = nowHongKong().bizDate;
  const fileName = `會員總覽與流水_${exportDate}.xlsx`;
  return { workbook, exportDate, fileName };
}

export async function exportMemberLedgerWorkbookBase64() {
  const { workbook } = await buildMemberLedgerWorkbook();
  return XLSX.write(workbook, { type: "base64", bookType: "xlsx" });
}

export async function exportMemberLedgerWorkbook() {
  const { workbook, fileName } = await buildMemberLedgerWorkbook();
  XLSX.writeFile(workbook, fileName);
}
