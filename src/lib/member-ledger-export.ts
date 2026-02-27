"use client";

import { buildMemberStats } from "@/lib/analytics";
import { getMembersLocal, getTransactionsLocal } from "@/lib/local-db";
import { getLockedDiscountRateFromTransactions } from "@/lib/pricing";
import { nowHongKong } from "@/lib/time";
import type { Member, TransactionLineItem, TransactionRecord } from "@/lib/types";
import * as XLSX from "xlsx";

const MEMBER_IMPORT_TEMPLATE_HEADERS = [
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
  "當前折扣檔位(如7.5折，可空)",
  "備註",
] as const;

const MEMBER_IMPORT_TEMPLATE_COLS = [
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
  { wch: 20 },
  { wch: 28 },
] as const;

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

function formatRateInput(rate?: number) {
  if (!Number.isFinite(rate) || !rate || rate <= 0 || rate > 1) {
    return "";
  }
  const discount = (rate * 10).toFixed(rate * 10 % 1 === 0 ? 0 : 1);
  return `${discount}折`;
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

function isLikelyTestMember(member: Member) {
  const name = member.name.trim().toLowerCase();
  const notes = member.notes.trim().toLowerCase();
  const email = member.email.trim().toLowerCase();
  if (name === "示例會員_請刪除" || name.includes("測試") || name.includes("测试") || name.includes("demo")) {
    return true;
  }
  if (notes.includes("測試") || notes.includes("测试") || notes.includes("demo") || notes.includes("示例")) {
    return true;
  }
  if (email.endsWith("@example.com")) {
    return true;
  }
  return false;
}

function createMemberImportTemplateRows(members?: Member[]) {
  const rows: Array<Array<string | number>> = [
    [...MEMBER_IMPORT_TEMPLATE_HEADERS],
    [
      "示例會員_請刪除",
      "0912345678",
      "demo@example.com",
      5000,
      "女",
      "1995-10-10",
      "VIP001",
      "wechat_demo",
      nowHongKong().bizDate,
      "啟用",
      "7.5折",
      "示例行，導入前請刪除",
    ],
  ];
  if (members && members.length > 0) {
    rows.push(
      ...members.map((member) => [
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
        formatRateInput(member.manual_locked_discount_rate),
        member.notes || "",
      ]),
    );
  }
  return rows;
}

interface MemberLedgerWorkbookOptions {
  includeTemplates?: boolean;
  excludeTestData?: boolean;
}

export async function buildMemberLedgerWorkbook(options?: MemberLedgerWorkbookOptions) {
  const includeTemplates = options?.includeTemplates ?? true;
  const excludeTestData = options?.excludeTestData ?? false;
  const [rawMembers, rawTransactions] = await Promise.all([
    getMembersLocal({ includeInactive: true, limit: 100000 }),
    getTransactionsLocal(),
  ]);
  const members = excludeTestData ? rawMembers.filter((member) => !isLikelyTestMember(member)) : rawMembers;
  const memberIdSet = new Set(members.map((member) => member.member_id));
  const transactions = excludeTestData
    ? rawTransactions.filter((row) => !row.member_id || memberIdSet.has(row.member_id))
    : rawTransactions;

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
      member.manual_locked_discount_rate,
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
      member.manual_locked_discount_rate,
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

  if (includeTemplates) {
    const memberTemplateRows = createMemberImportTemplateRows(sortedMembers);
    const memberTemplateSheet = XLSX.utils.aoa_to_sheet(memberTemplateRows);
    memberTemplateSheet["!cols"] = [...MEMBER_IMPORT_TEMPLATE_COLS];
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
  }

  const exportDate = nowHongKong().bizDate;
  const fileName = `會員總覽與流水_${exportDate}.xlsx`;
  return { workbook, exportDate, fileName };
}

export async function exportMemberLedgerWorkbookBase64() {
  const { workbook } = await buildMemberLedgerWorkbook();
  return XLSX.write(workbook, { type: "base64", bookType: "xlsx" });
}

export async function exportMemberBackupWorkbookBase64() {
  const { workbook } = await buildMemberLedgerWorkbook({
    includeTemplates: false,
    excludeTestData: true,
  });
  return XLSX.write(workbook, { type: "base64", bookType: "xlsx" });
}

export async function exportMemberLedgerWorkbook() {
  const { workbook, fileName } = await buildMemberLedgerWorkbook();
  XLSX.writeFile(workbook, fileName);
}

export async function exportMemberImportTemplateWorkbook() {
  const workbook = XLSX.utils.book_new();
  const guideRows: Array<Array<string>> = [
    ["會員導入說明"],
    ["1. 必填：姓名、電話(唯一鍵)、餘額(HKD)。"],
    ["2. 當前折扣檔位填法：7.5折 / 8折 / 8.5折 / 9折；留空=按餘額自動算。"],
    ["3. 初次上線不導入舊流水也可以，系統會按『當前餘額 + 當前折扣檔位』直接開單。"],
    ["4. 同電話重複導入時，系統會逐條詢問是否覆蓋。"],
    ["5. 範例行會自動跳過，不會真的入庫。"],
  ];
  const guideSheet = XLSX.utils.aoa_to_sheet(guideRows);
  guideSheet["!cols"] = [{ wch: 100 }];
  XLSX.utils.book_append_sheet(workbook, guideSheet, "使用說明");

  const templateRows = createMemberImportTemplateRows();
  const templateSheet = XLSX.utils.aoa_to_sheet(templateRows);
  templateSheet["!cols"] = [...MEMBER_IMPORT_TEMPLATE_COLS];
  XLSX.utils.book_append_sheet(workbook, templateSheet, "導入模板_會員");

  const fileName = `會員導入模板_${nowHongKong().bizDate}.xlsx`;
  XLSX.writeFile(workbook, fileName);
}
