"use client";

import {
  buildGlobalAnalysis,
  buildMemberStats,
  filterTransactionsByRange,
  type AnalysisRange,
} from "@/lib/analytics";
import { getMembersLocal, getPriceListLocal, getTransactionsLocal } from "@/lib/local-db";
import { executeReversalLocal } from "@/lib/local-transactions";
import { formatCurrency } from "@/lib/time";
import type { Member, TransactionRecord } from "@/lib/types";
import { useEffect, useMemo, useState } from "react";

interface FilterState {
  from: string;
  to: string;
  txn_type: "ALL" | "TOPUP" | "SPEND";
  category: string;
}

const INITIAL_FILTER: FilterState = {
  from: "",
  to: "",
  txn_type: "ALL",
  category: "",
};

const RANGE_OPTIONS: Array<{ value: AnalysisRange; label: string }> = [
  { value: "WEEK", label: "本周" },
  { value: "30D", label: "最近30天" },
  { value: "QUARTER", label: "最近一季度" },
  { value: "365D", label: "最近365天" },
  { value: "ALL", label: "所有" },
];

interface ParsedTxnItem {
  item_id: string;
  item_name: string;
  category: string;
  quantity: number;
  line_amount: number;
}

interface ReceiptDetailLine {
  category: string;
  itemName: string;
  quantity: number;
  gross: number;
  memberDeduct: number;
  externalPay: number;
  lineTotal: number;
  discountLabel: string;
}

interface ReceiptDetail {
  lines: ReceiptDetailLine[];
  showExternalColumn: boolean;
  totalPayable: number;
  memberSavings: number;
  discountLabel: string;
  memberDeductTotal: number;
  externalPayTotal: number;
}

function hasAmount(value: number) {
  return Number.isFinite(value) && Math.abs(value) >= 0.005;
}

function formatAmountOrDash(value: number) {
  return hasAmount(value) ? formatCurrency(value) : "—";
}

function formatTxnTypeLabel(type: "TOPUP" | "SPEND") {
  return type === "TOPUP" ? "充值" : "消費";
}

function safeParseItems(row: TransactionRecord) {
  if (!row.items_json) {
    return [] as ParsedTxnItem[];
  }
  try {
    const raw = JSON.parse(row.items_json) as Array<{
      item_id?: string;
      item_name?: string;
      category?: string;
      quantity?: number;
      line_amount?: number;
    }>;
    return raw
      .map((item) => ({
        item_id: item.item_id ?? "",
        item_name: item.item_name ?? "",
        category: item.category ?? "",
        quantity: Math.max(1, Number(item.quantity ?? 1) || 1),
        line_amount: Math.max(0, Number(item.line_amount ?? 0) || 0),
      }))
      .filter((item) => item.item_name || item.line_amount > 0);
  } catch {
    return [] as ParsedTxnItem[];
  }
}

function buildReceiptDetail(row: TransactionRecord): ReceiptDetail | null {
  if (row.txn_type !== "SPEND") {
    return null;
  }
  const items = safeParseItems(row);
  if (items.length === 0) {
    return null;
  }

  const memberDeductTotal = Math.max(0, row.net_amount);
  const externalPayTotal = Math.max(0, row.external_pay_amount ?? 0);
  const totalPayable = memberDeductTotal + externalPayTotal;
  const discountRate = row.discount_rate > 0 ? row.discount_rate : 1;
  const discountLabel = `${(discountRate * 100).toFixed(0)}%`;
  const isMember = Boolean(row.member_id);
  const showExternalColumn = !isMember || hasAmount(externalPayTotal);

  let coveredGrossRemaining = isMember
    ? Math.min(row.gross_amount, memberDeductTotal / discountRate)
    : 0;
  const lines = items.map((item) => {
    const gross = item.line_amount;
    const coveredGross = isMember ? Math.min(gross, coveredGrossRemaining) : 0;
    coveredGrossRemaining = Math.max(coveredGrossRemaining - coveredGross, 0);
    const uncoveredGross = isMember ? Math.max(gross - coveredGross, 0) : gross;
    const memberDeduct = isMember ? coveredGross * discountRate : 0;
    const externalPay = isMember ? uncoveredGross : gross;
    let lineDiscountLabel = "原價";
    if (isMember) {
      if (hasAmount(memberDeduct) && hasAmount(externalPay)) {
        lineDiscountLabel = `${discountLabel}（部分）`;
      } else if (hasAmount(memberDeduct)) {
        lineDiscountLabel = discountLabel;
      } else {
        lineDiscountLabel = "無折扣";
      }
    }
    return {
      category: item.category || "未分類",
      itemName: item.item_name || item.item_id || "未命名項目",
      quantity: item.quantity,
      gross,
      memberDeduct,
      externalPay,
      lineTotal: memberDeduct + externalPay,
      discountLabel: lineDiscountLabel,
    };
  });

  if (lines.length > 0) {
    const memberDelta =
      memberDeductTotal - lines.reduce((sum, line) => sum + line.memberDeduct, 0);
    const externalDelta =
      externalPayTotal - lines.reduce((sum, line) => sum + line.externalPay, 0);
    const last = lines[lines.length - 1];
    last.memberDeduct += memberDelta;
    last.externalPay += externalDelta;
    last.lineTotal += memberDelta + externalDelta;
  }

  return {
    lines,
    showExternalColumn,
    totalPayable,
    memberSavings: Math.max(row.gross_amount - totalPayable, 0),
    discountLabel,
    memberDeductTotal,
    externalPayTotal,
  };
}

const CHART_COLORS = [
  "#0e7490",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#6366f1",
  "#ec4899",
  "#84cc16",
  "#64748b",
];

export default function TransactionsPanel() {
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTER);
  const [allTransactions, setAllTransactions] = useState<TransactionRecord[]>([]);
  const [allMembers, setAllMembers] = useState<Member[]>([]);
  const [analysisRange, setAnalysisRange] = useState<AnalysisRange>("30D");
  const [categories, setCategories] = useState<string[]>([]);
  const [expandedTxnIds, setExpandedTxnIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  const transactions = useMemo(() => {
    let rows = allTransactions.slice();

    if (filters.from) {
      rows = rows.filter((row) => row.biz_date >= filters.from);
    }
    if (filters.to) {
      rows = rows.filter((row) => row.biz_date <= filters.to);
    }
    if (filters.txn_type !== "ALL") {
      rows = rows.filter((row) => row.txn_type === filters.txn_type);
    }
    if (filters.category) {
      rows = rows.filter((row) => {
        if (!row.items_json) {
          return false;
        }
        try {
          const items = JSON.parse(row.items_json) as Array<{ category?: string }>;
          return items.some((item) => item.category === filters.category);
        } catch {
          return false;
        }
      });
    }

    return rows;
  }, [allTransactions, filters]);

  const rangeTransactions = useMemo(
    () => filterTransactionsByRange(allTransactions, analysisRange),
    [allTransactions, analysisRange],
  );

  const globalAnalysis = useMemo(
    () => buildGlobalAnalysis(rangeTransactions, allMembers),
    [rangeTransactions, allMembers],
  );

  const memberStats = useMemo(
    () => buildMemberStats(allMembers.filter((member) => member.active), allTransactions),
    [allMembers, allTransactions],
  );

  const memberActivityBuckets = useMemo(() => {
    const bucketMap = new Map<string, { label: string; count: number; color: string }>([
      ["ACTIVE_7D", { label: "7天內", count: 0, color: "bg-emerald-600" }],
      ["ACTIVE_30D", { label: "8-30天", count: 0, color: "bg-cyan-600" }],
      ["WARM_90D", { label: "31-90天", count: 0, color: "bg-amber-500" }],
      ["DORMANT_365D", { label: "91-365天", count: 0, color: "bg-rose-500" }],
      ["DORMANT_365P", { label: "365天以上", count: 0, color: "bg-slate-700" }],
      ["NEVER", { label: "從未消費", count: 0, color: "bg-slate-400" }],
    ]);

    memberStats.forEach((stat) => {
      if (stat.lastSpendDays === null) {
        bucketMap.get("NEVER")!.count += 1;
        return;
      }
      if (stat.lastSpendDays <= 7) {
        bucketMap.get("ACTIVE_7D")!.count += 1;
      } else if (stat.lastSpendDays <= 30) {
        bucketMap.get("ACTIVE_30D")!.count += 1;
      } else if (stat.lastSpendDays <= 90) {
        bucketMap.get("WARM_90D")!.count += 1;
      } else if (stat.lastSpendDays <= 365) {
        bucketMap.get("DORMANT_365D")!.count += 1;
      } else {
        bucketMap.get("DORMANT_365P")!.count += 1;
      }
    });

    return Array.from(bucketMap.values());
  }, [memberStats]);

  const trendData = useMemo(() => {
    const map = new Map<string, { date: string; spend: number; topup: number }>();
    rangeTransactions.forEach((row) => {
      const old = map.get(row.biz_date) ?? { date: row.biz_date, spend: 0, topup: 0 };
      if (row.txn_type === "SPEND") {
        old.spend += row.net_amount + (row.external_pay_amount ?? 0);
      } else {
        old.topup += row.net_amount;
      }
      map.set(row.biz_date, old);
    });
    return Array.from(map.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30);
  }, [rangeTransactions]);

  const topupVsSpend = useMemo(
    () => [
      { label: "消費", value: globalAnalysis.totalSpend, color: "bg-cyan-700" },
      { label: "充值", value: globalAnalysis.totalTopup, color: "bg-emerald-600" },
    ],
    [globalAnalysis.totalSpend, globalAnalysis.totalTopup],
  );

  const flowMetrics = useMemo(() => {
    const memberDeduct = rangeTransactions
      .filter((row) => row.txn_type === "SPEND")
      .reduce((sum, row) => sum + row.net_amount, 0);
    const extraPay = rangeTransactions
      .filter((row) => row.txn_type === "SPEND")
      .reduce((sum, row) => sum + (row.external_pay_amount ?? 0), 0);
    const serviceReceivable = memberDeduct + extraPay;
    const topupIn = rangeTransactions
      .filter((row) => row.txn_type === "TOPUP")
      .reduce((sum, row) => sum + row.net_amount, 0);
    const storedValueChange = topupIn - memberDeduct;
    const instantCashIn = topupIn + extraPay;
    return { memberDeduct, extraPay, serviceReceivable, topupIn, storedValueChange, instantCashIn };
  }, [rangeTransactions]);

  const categoryShare = useMemo(() => {
    const map = new Map<string, number>();
    rangeTransactions.forEach((row) => {
      if (row.txn_type !== "SPEND") {
        return;
      }
      const items = safeParseItems(row);
      if (items.length === 0) {
        map.set("未分類", (map.get("未分類") ?? 0) + row.gross_amount);
        return;
      }
      items.forEach((item) => {
        const key = item.category?.trim() || "未分類";
        const amount = Number(item.line_amount ?? 0);
        map.set(key, (map.get(key) ?? 0) + (Number.isFinite(amount) ? amount : 0));
      });
    });
    const total = Array.from(map.values()).reduce((sum, value) => sum + value, 0);
    const sortedRows = Array.from(map.entries())
      .map(([category, amount]) => ({
        category,
        amount,
        ratio: total > 0 ? amount / total : 0,
      }))
      .sort((a, b) => b.amount - a.amount);
    const rows = sortedRows.slice(0, 8);
    const topAmount = rows.reduce((sum, row) => sum + row.amount, 0);
    const otherAmount = Math.max(total - topAmount, 0);
    if (otherAmount > 0.01) {
      rows.push({
        category: "其他",
        amount: otherAmount,
        ratio: total > 0 ? otherAmount / total : 0,
      });
    }
    return { total, rows };
  }, [rangeTransactions]);

  const reversedTargetIdSet = useMemo(
    () =>
      new Set(
        allTransactions
          .map((row) => row.reversal_of_txn_id)
          .filter((value): value is string => Boolean(value)),
      ),
    [allTransactions],
  );

  const latestTxnByMember = useMemo(() => {
    const map = new Map<string, string>();
    allTransactions.forEach((row) => {
      if (!map.has(row.member_id)) {
        map.set(row.member_id, row.txn_id);
      }
    });
    return map;
  }, [allTransactions]);

  function canReverse(row: TransactionRecord) {
    if (!row.member_id) return false;
    if (row.reversal_of_txn_id) return false;
    if (row.reversed_by_txn_id) return false;
    if (reversedTargetIdSet.has(row.txn_id)) return false;
    return latestTxnByMember.get(row.member_id) === row.txn_id;
  }

  async function loadTransactions() {
    setLoading(true);
    setError("");
    try {
      const [txns, priceList, members] = await Promise.all([
        getTransactionsLocal(),
        getPriceListLocal(),
        getMembersLocal({ includeInactive: true, limit: 100000 }),
      ]);
      setAllTransactions(txns);
      setCategories(Array.from(new Set(priceList.map((item) => item.category))).filter(Boolean));
      setAllMembers(members);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "讀取流水失敗");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTransactions().catch(() => {
      // ignore
    });
  }, []);

  async function reverseTransaction(row: TransactionRecord) {
    if (!canReverse(row)) {
      setError("只能撤回該會員最近一筆且未撤回的流水");
      return;
    }
    const ok = window.confirm(`確定撤回這筆${formatTxnTypeLabel(row.txn_type)}流水？`);
    if (!ok) {
      return;
    }
    setLoading(true);
    setError("");
    setActionMessage("");
    try {
      await executeReversalLocal({
        txn_id: row.txn_id,
        request_id: crypto.randomUUID(),
        source_device: window.innerWidth > 768 ? "iPad" : "Phone",
      });
      setActionMessage("撤回成功，已生成沖正流水");
      await loadTransactions();
    } catch (reverseError) {
      setError(reverseError instanceof Error ? reverseError.message : "撤回失敗");
    } finally {
      setLoading(false);
    }
  }

  function toggleTxnDetail(txnId: string) {
    setExpandedTxnIds((prev) => {
      const next = new Set(prev);
      if (next.has(txnId)) {
        next.delete(txnId);
      } else {
        next.add(txnId);
      }
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">全店分析</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {RANGE_OPTIONS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setAnalysisRange(item.value)}
              className={`rounded-xl px-3 py-2 text-sm font-semibold ${
                analysisRange === item.value
                  ? "bg-cyan-700 text-white"
                  : "bg-slate-100 text-slate-700"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="text-xs text-slate-500">本期服務應收</p>
            <p className="text-lg font-semibold text-slate-900">
              {formatCurrency(flowMetrics.serviceReceivable)}
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="text-xs text-slate-500">本期充值入賬</p>
            <p className="text-lg font-semibold text-slate-900">
              {formatCurrency(flowMetrics.topupIn)}
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="text-xs text-slate-500">儲值池變化（充-扣）</p>
            <p className="text-lg font-semibold text-slate-900">
              {formatCurrency(flowMetrics.storedValueChange)}
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="text-xs text-slate-500">即時現金流入（充+另收）</p>
            <p className="text-lg font-semibold text-slate-900">{formatCurrency(flowMetrics.instantCashIn)}</p>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="text-xs text-slate-500">平均客單</p>
            <p className="text-lg font-semibold text-slate-900">
              {formatCurrency(globalAnalysis.avgTicket)}
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="text-xs text-slate-500">消費筆數</p>
            <p className="text-lg font-semibold text-slate-900">
              {globalAnalysis.spendCount}
            </p>
          </div>
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-sm font-semibold text-slate-900">日營收趨勢（近30天）</p>
            {trendData.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">暫無數據</p>
            ) : (
              <>
                {(() => {
                  const maxValue = Math.max(...trendData.map((row) => row.spend + row.topup), 1);
                  const yTicks = [1, 0.75, 0.5, 0.25, 0].map((ratio) => maxValue * ratio);
                  const firstDate = trendData[0]?.date ?? "";
                  const midDate = trendData[Math.floor(trendData.length / 2)]?.date ?? "";
                  const lastDate = trendData[trendData.length - 1]?.date ?? "";
                  return (
                    <div className="mt-3 rounded-lg bg-slate-50 px-2 py-2">
                      <div className="flex gap-2">
                        <div className="flex h-32 flex-col justify-between text-[10px] text-slate-500">
                          {yTicks.map((tick, idx) => (
                            <span key={`txn-y-tick-${idx}`} className="tabular-nums">
                              {formatCurrency(tick)}
                            </span>
                          ))}
                        </div>
                        <div className="relative flex-1">
                          <div className="absolute inset-0 flex flex-col justify-between">
                            {yTicks.map((_, idx) => (
                              <div key={`txn-grid-${idx}`} className="border-t border-dashed border-slate-200" />
                            ))}
                          </div>
                          <div className="relative flex h-32 items-end gap-1">
                            {trendData.map((row) => (
                              <div key={row.date} className="flex h-full flex-1 flex-col justify-end">
                                <div
                                  className="w-full rounded-t-sm bg-emerald-500"
                                  style={{ height: `${(row.topup / maxValue) * 100}%` }}
                                  title={`${row.date} 充值 ${formatCurrency(row.topup)}`}
                                />
                                <div
                                  className="mt-[2px] w-full rounded-t-sm bg-cyan-700"
                                  style={{ height: `${(row.spend / maxValue) * 100}%` }}
                                  title={`${row.date} 消費 ${formatCurrency(row.spend)}`}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                        <span>{firstDate}</span>
                        <span>{midDate}</span>
                        <span>{lastDate}</span>
                      </div>
                      <p className="mt-1 text-[10px] text-slate-500">X軸：日期　Y軸：金額（HKD）｜綠色=充值，藍色=消費</p>
                    </div>
                  );
                })()}
              </>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-sm font-semibold text-slate-900">充值 vs 消費</p>
            <div className="mt-3 space-y-2">
              {(() => {
                const maxValue = Math.max(...topupVsSpend.map((item) => item.value), 1);
                return topupVsSpend.map((item) => (
                  <div key={item.label}>
                    <div className="mb-1 flex items-center justify-between text-xs text-slate-600">
                      <span>{item.label}</span>
                      <span className="tabular-nums">{formatCurrency(item.value)}</span>
                    </div>
                    <div className="h-3 rounded-full bg-slate-100">
                      <div
                        className={`h-3 rounded-full ${item.color}`}
                        style={{ width: `${(item.value / maxValue) * 100}%` }}
                      />
                    </div>
                  </div>
                ));
              })()}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-sm font-semibold text-slate-900">項目分類占比</p>
            {categoryShare.rows.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">暫無數據</p>
            ) : (
              <div className="mt-3 grid gap-3 md:grid-cols-[140px_1fr]">
                <div
                  className="mx-auto h-32 w-32 rounded-full"
                  style={{
                    background: `conic-gradient(${categoryShare.rows
                      .map((item, index) => {
                        const prevRatio = categoryShare.rows
                          .slice(0, index)
                          .reduce((sum, row) => sum + row.ratio, 0);
                        const start = prevRatio * 100;
                        const end = (prevRatio + item.ratio) * 100;
                        return `${CHART_COLORS[index % CHART_COLORS.length]} ${start}% ${end}%`;
                      })
                      .join(", ")})`,
                  }}
                />
                <div className="space-y-1 text-sm">
                  {categoryShare.rows.map((item, index) => (
                    <div key={item.category} className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 text-slate-700">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: CHART_COLORS[index % CHART_COLORS.length] }}
                        />
                        {item.category}
                      </span>
                      <span className="tabular-nums text-slate-600">
                        {formatCurrency(item.amount)}（{(item.ratio * 100).toFixed(1)}%）
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-sm font-semibold text-slate-900">會員活躍度分層</p>
            <div className="mt-3 space-y-2">
              {(() => {
                const maxCount = Math.max(
                  ...memberActivityBuckets.map((item) => item.count),
                  1,
                );
                return memberActivityBuckets.map((item) => (
                  <div key={item.label}>
                    <div className="mb-1 flex items-center justify-between text-xs text-slate-600">
                      <span>{item.label}</span>
                      <span>{item.count} 人</span>
                    </div>
                    <div className="h-3 rounded-full bg-slate-100">
                      <div
                        className={`h-3 rounded-full ${item.color}`}
                        style={{ width: `${(item.count / maxCount) * 100}%` }}
                      />
                    </div>
                  </div>
                ));
              })()}
            </div>
          </div>

        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-sm font-semibold text-slate-900">熱門項目 Top 10</p>
            <div className="mt-2 space-y-1 text-sm">
              {globalAnalysis.topProjects.length === 0 ? (
                <p className="text-slate-500">暫無數據</p>
              ) : (
                globalAnalysis.topProjects.map((item, index) => (
                  <p key={item.itemName} className="text-slate-700">
                    {index + 1}. {item.itemName}（{item.count} 次）
                  </p>
                ))
              )}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-sm font-semibold text-slate-900">充值最高會員</p>
            <div className="mt-2 space-y-1 text-sm">
              {globalAnalysis.topMembersByTopup.length === 0 ? (
                <p className="text-slate-500">暫無數據</p>
              ) : (
                globalAnalysis.topMembersByTopup.slice(0, 10).map((member, index) => (
                  <p key={member.memberId} className="text-slate-700">
                    {index + 1}. {member.memberName}（{formatCurrency(member.topup)}）
                  </p>
                ))
              )}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-sm font-semibold text-slate-900">消費最高會員</p>
            <div className="mt-2 space-y-1 text-sm">
              {globalAnalysis.topMembersBySpend.length === 0 ? (
                <p className="text-slate-500">暫無數據</p>
              ) : (
                globalAnalysis.topMembersBySpend.slice(0, 10).map((member, index) => (
                  <p key={member.memberId} className="text-slate-700">
                    {index + 1}. {member.memberName}（{formatCurrency(member.spend)}）
                  </p>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-slate-200 p-3">
          <p className="text-sm font-semibold text-slate-900">折扣分布</p>
          <div className="mt-2 space-y-2 text-sm">
            {globalAnalysis.discountDistribution.length === 0 ? (
              <p className="text-slate-500">暫無消費數據</p>
            ) : (
              (() => {
                const maxCount = Math.max(
                  ...globalAnalysis.discountDistribution.map((item) => item.count),
                  1,
                );
                return globalAnalysis.discountDistribution.map((item) => (
                  <div key={item.discountRate}>
                    <div className="mb-1 flex items-center justify-between text-xs text-slate-600">
                      <span>{(item.discountRate * 100).toFixed(0)}%</span>
                      <span>{item.count} 單</span>
                    </div>
                    <div className="h-3 rounded-full bg-slate-100">
                      <div
                        className="h-3 rounded-full bg-fuchsia-600"
                        style={{ width: `${(item.count / maxCount) * 100}%` }}
                      />
                    </div>
                  </div>
                ));
              })()
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">篩選條件</h2>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <input
            type="date"
            value={filters.from}
            onChange={(event) => setFilters((prev) => ({ ...prev, from: event.target.value }))}
            className="h-11 rounded-xl border border-slate-200 px-3"
          />
          <input
            type="date"
            value={filters.to}
            onChange={(event) => setFilters((prev) => ({ ...prev, to: event.target.value }))}
            className="h-11 rounded-xl border border-slate-200 px-3"
          />
          <select
            value={filters.txn_type}
            onChange={(event) =>
              setFilters((prev) => ({
                ...prev,
                txn_type: event.target.value as "ALL" | "TOPUP" | "SPEND",
              }))
            }
            className="h-11 rounded-xl border border-slate-200 px-3"
          >
            <option value="ALL">全部類型</option>
            <option value="TOPUP">充值</option>
            <option value="SPEND">消費</option>
          </select>
          <select
            value={filters.category}
            onChange={(event) => setFilters((prev) => ({ ...prev, category: event.target.value }))}
            className="h-11 rounded-xl border border-slate-200 px-3"
          >
            <option value="">全部分類</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={loadTransactions}
              disabled={loading}
              className="h-11 w-full rounded-xl bg-cyan-700 font-semibold text-white"
            >
              {loading ? "查詢中" : "刷新"}
            </button>
          </div>
        </div>
        {error && <p className="mt-2 text-sm font-semibold text-rose-700">{error}</p>}
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="mb-2 text-sm text-slate-600">共 {transactions.length} 條記錄</p>
        <div className="space-y-2">
          {transactions.map((row) => {
            const expanded = expandedTxnIds.has(row.txn_id);
            const detail = buildReceiptDetail(row);
            return (
              <div key={row.txn_id} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-slate-900">
                    {row.biz_date} {row.biz_time}
                  </p>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        row.txn_type === "TOPUP"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {formatTxnTypeLabel(row.txn_type)}
                    </span>
                    {row.reversal_of_txn_id && (
                      <span className="rounded-full bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-700">
                        沖正單
                      </span>
                    )}
                    {(row.reversed_by_txn_id || reversedTargetIdSet.has(row.txn_id)) && (
                      <span className="rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-700">
                        已撤回
                      </span>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-sm text-slate-700">
                  會員：{row.member_name_snapshot || "散客"}（{row.customer_gender || "-"}）
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  折前 {formatCurrency(row.gross_amount)} ｜ 會員扣款 {formatCurrency(row.net_amount)} ｜ 另收 {formatCurrency(row.external_pay_amount ?? 0)} ｜
                  折扣 {(row.discount_rate * 100).toFixed(0)}%
                </p>
                {(row.extra_discount_amount ?? 0) > 0 && (
                  <p className="mt-1 text-sm text-amber-700">額外優惠：{formatCurrency(row.extra_discount_amount ?? 0)}</p>
                )}
                {(row.floor_discount_amount ?? 0) > 0 && (
                  <p className="mt-1 text-sm text-amber-700">已按整數結算，去小數優惠：{formatCurrency(row.floor_discount_amount ?? 0)}</p>
                )}
                <p className="mt-1 text-sm text-slate-700">
                  餘額 {formatCurrency(row.balance_before)} → {formatCurrency(row.balance_after)}
                </p>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {(row.txn_type === "SPEND" || row.txn_type === "TOPUP") && (
                    <button
                      type="button"
                      onClick={() => toggleTxnDetail(row.txn_id)}
                      className="rounded-lg bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700"
                    >
                      {expanded ? "收起本單明細" : "查看本單明細"}
                    </button>
                  )}
                  {!row.reversal_of_txn_id && canReverse(row) && (
                    <button
                      type="button"
                      onClick={() => reverseTransaction(row)}
                      disabled={loading}
                      className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                    >
                      撤回本筆
                    </button>
                  )}
                </div>

                {expanded && row.txn_type === "TOPUP" && (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                    <p className="font-semibold text-slate-800">充值明細</p>
                    <div className="mt-2 grid grid-cols-2 gap-y-1">
                      <span className="text-slate-500">充值金額</span>
                      <span className="text-right tabular-nums font-semibold text-emerald-700">
                        {formatCurrency(row.net_amount)}
                      </span>
                      <span className="text-slate-500">餘額變化</span>
                      <span className="text-right tabular-nums text-slate-700">
                        {formatCurrency(row.balance_before)} → {formatCurrency(row.balance_after)}
                      </span>
                    </div>
                  </div>
                )}

                {expanded && row.txn_type === "SPEND" && (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2">
                    {detail ? (
                      <>
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[700px] text-sm">
                            <thead className="bg-white text-xs text-slate-500">
                              <tr>
                                <th className="px-2 py-2 text-left font-semibold">項目 Item</th>
                                <th className="px-2 py-2 text-right font-semibold">原價小計 Gross</th>
                                <th className="px-2 py-2 text-right font-semibold">折扣 Discount</th>
                                <th className="px-2 py-2 text-right font-semibold">會員折後 Member</th>
                                {detail.showExternalColumn && (
                                  <th className="px-2 py-2 text-right font-semibold">餘額外原價 Extra</th>
                                )}
                                <th className="px-2 py-2 text-right font-semibold">本項應收 Payable</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-200 bg-white">
                              {detail.lines.map((line, index) => (
                                <tr key={`${row.txn_id}-${line.itemName}-${index}`}>
                                  <td className="px-2 py-2 text-slate-700">
                                    {line.category}｜{line.itemName} x{line.quantity}
                                  </td>
                                  <td className="px-2 py-2 text-right tabular-nums text-slate-600">
                                    {formatCurrency(line.gross)}
                                  </td>
                                  <td className="px-2 py-2 text-right tabular-nums text-slate-600">
                                    {line.discountLabel}
                                  </td>
                                  <td className="px-2 py-2 text-right tabular-nums font-semibold text-emerald-700">
                                    {formatAmountOrDash(line.memberDeduct)}
                                  </td>
                                  {detail.showExternalColumn && (
                                    <td className="px-2 py-2 text-right tabular-nums font-semibold text-amber-700">
                                      {formatAmountOrDash(line.externalPay)}
                                    </td>
                                  )}
                                  <td className="px-2 py-2 text-right tabular-nums font-semibold text-slate-900">
                                    {formatCurrency(line.lineTotal)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="mt-2 rounded-lg border border-slate-200 bg-white p-2 text-sm">
                          <div className="grid grid-cols-2 gap-y-1">
                            <span className="text-slate-500">折前小計 Subtotal</span>
                            <span className="text-right tabular-nums text-slate-700">
                              {formatCurrency(row.gross_amount)}
                            </span>
                            <span className="text-slate-500">折扣檔位 Discount</span>
                            <span className="text-right tabular-nums text-slate-700">
                              {detail.discountLabel}
                            </span>
                            <span className="text-slate-500">會員扣款 Member</span>
                            <span className="text-right tabular-nums font-semibold text-emerald-700">
                              {formatAmountOrDash(detail.memberDeductTotal)}
                            </span>
                            {detail.showExternalColumn && (
                              <>
                                <span className="text-slate-500">另收金額 Extra</span>
                                <span className="text-right tabular-nums font-semibold text-amber-700">
                                  {formatAmountOrDash(detail.externalPayTotal)}
                                </span>
                              </>
                            )}
                            <span className="text-slate-500">最終應收 Payable</span>
                            <span className="text-right tabular-nums font-semibold text-slate-900">
                              {formatCurrency(detail.totalPayable)}
                            </span>
                            <span className="text-slate-500">會員本單共省 Saved</span>
                            <span className="text-right tabular-nums font-semibold text-cyan-700">
                              {formatAmountOrDash(detail.memberSavings)}
                            </span>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-500">
                        本單沒有可解析的項目明細。
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {actionMessage && <p className="mt-3 text-sm font-semibold text-emerald-700">{actionMessage}</p>}
      </section>
    </div>
  );
}
