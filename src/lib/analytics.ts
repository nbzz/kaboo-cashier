import { nowHongKong } from "@/lib/time";
import type { Member, TransactionLineItem, TransactionRecord } from "@/lib/types";

export type AnalysisRange = "WEEK" | "30D" | "QUARTER" | "365D" | "ALL";

export interface MemberStat {
  memberId: string;
  totalTopup: number;
  totalSpend: number;
  spendCount: number;
  lastSpendAt: string;
  lastSpendDays: number | null;
  recent30Spend: number;
  recent90Spend: number;
  netStored: number;
  avgMonthlySpend90: number;
  balanceCoverageMonths: number | null;
  lifecycle: "ACTIVE" | "WARM" | "RISK" | "DORMANT" | "NEVER";
  lifecycleLabel: string;
  favoriteTop1: string;
  favoriteTop3: string[];
}

export interface GlobalProjectStat {
  itemName: string;
  count: number;
  grossAmount: number;
}

export interface GlobalMemberStat {
  memberId: string;
  memberName: string;
  topup: number;
  spend: number;
}

export interface GlobalAnalysis {
  totalSpend: number;
  totalTopup: number;
  spendCount: number;
  topupCount: number;
  avgTicket: number;
  netCashflow: number;
  manualAdjustCount: number;
  discountDistribution: Array<{ discountRate: number; count: number }>;
  topProjects: GlobalProjectStat[];
  topMembersByTopup: GlobalMemberStat[];
  topMembersBySpend: GlobalMemberStat[];
}

function safeParseItems(row: TransactionRecord): TransactionLineItem[] {
  if (!row.items_json) {
    return [];
  }
  try {
    return JSON.parse(row.items_json) as TransactionLineItem[];
  } catch {
    return [];
  }
}

function ymdToDate(ymd: string) {
  return new Date(`${ymd}T00:00:00`);
}

function calcDaysDiffFromToday(ymd: string) {
  if (!ymd) {
    return null;
  }
  const target = ymdToDate(ymd);
  if (Number.isNaN(target.getTime())) {
    return null;
  }
  const today = ymdToDate(nowHongKong().bizDate);
  const diffMs = today.getTime() - target.getTime();
  if (!Number.isFinite(diffMs)) {
    return null;
  }
  const diff = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return diff >= 0 ? diff : 0;
}

function getLifecycleByDays(days: number | null) {
  if (days === null) {
    return { lifecycle: "NEVER" as const, label: "從未消費" };
  }
  if (days <= 30) {
    return { lifecycle: "ACTIVE" as const, label: "活躍" };
  }
  if (days <= 90) {
    return { lifecycle: "WARM" as const, label: "需跟進" };
  }
  if (days <= 180) {
    return { lifecycle: "RISK" as const, label: "流失風險" };
  }
  return { lifecycle: "DORMANT" as const, label: "沉睡客" };
}

function formatYmd(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfWeekMonday(date: Date) {
  const result = new Date(date);
  const day = result.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  return result;
}

export function filterTransactionsByRange(
  transactions: TransactionRecord[],
  range: AnalysisRange,
) {
  if (range === "ALL") {
    return transactions;
  }

  const today = ymdToDate(nowHongKong().bizDate);
  let start = new Date(today);

  if (range === "WEEK") {
    start = startOfWeekMonday(today);
  } else if (range === "30D") {
    start.setDate(today.getDate() - 29);
  } else if (range === "QUARTER") {
    start.setDate(today.getDate() - 89);
  } else if (range === "365D") {
    start.setDate(today.getDate() - 364);
  }

  const startYmd = formatYmd(start);
  const endYmd = formatYmd(today);
  return transactions.filter((row) => row.biz_date >= startYmd && row.biz_date <= endYmd);
}

export function buildMemberStats(
  members: Member[],
  transactions: TransactionRecord[],
): Map<string, MemberStat> {
  const today = ymdToDate(nowHongKong().bizDate);
  const start30 = new Date(today);
  start30.setDate(today.getDate() - 29);
  const start90 = new Date(today);
  start90.setDate(today.getDate() - 89);
  const start30Ymd = formatYmd(start30);
  const start90Ymd = formatYmd(start90);

  const map = new Map<string, MemberStat>();
  const memberById = new Map(members.map((member) => [member.member_id, member]));
  members.forEach((member) => {
    map.set(member.member_id, {
      memberId: member.member_id,
      totalTopup: 0,
      totalSpend: 0,
      spendCount: 0,
      lastSpendAt: "",
      lastSpendDays: null,
      recent30Spend: 0,
      recent90Spend: 0,
      netStored: 0,
      avgMonthlySpend90: 0,
      balanceCoverageMonths: null,
      lifecycle: "NEVER",
      lifecycleLabel: "從未消費",
      favoriteTop1: "-",
      favoriteTop3: [],
    });
  });

  const itemFreqMap = new Map<string, Map<string, { count: number; amount: number }>>();

  transactions.forEach((row) => {
    const stat = map.get(row.member_id);
    if (!stat) {
      return;
    }

    if (row.txn_type === "TOPUP") {
      stat.totalTopup += row.net_amount;
      return;
    }

    stat.totalSpend += row.net_amount + (row.external_pay_amount ?? 0);
    const spendAmount = row.net_amount + (row.external_pay_amount ?? 0);
    stat.spendCount += 1;
    const spendAt = `${row.biz_date} ${row.biz_time}`;
    if (!stat.lastSpendAt || spendAt > stat.lastSpendAt) {
      stat.lastSpendAt = spendAt;
    }
    if (row.biz_date >= start30Ymd) {
      stat.recent30Spend += spendAmount;
    }
    if (row.biz_date >= start90Ymd) {
      stat.recent90Spend += spendAmount;
    }

    const itemMap = itemFreqMap.get(row.member_id) ?? new Map();
    safeParseItems(row).forEach((item) => {
      const key = item.item_name || item.item_id;
      const old = itemMap.get(key) ?? { count: 0, amount: 0 };
      itemMap.set(key, {
        count: old.count + (item.quantity || 1),
        amount: old.amount + item.line_amount,
      });
    });
    itemFreqMap.set(row.member_id, itemMap);
  });

  map.forEach((stat, memberId) => {
    const member = memberById.get(memberId);
    const ymd = stat.lastSpendAt ? stat.lastSpendAt.slice(0, 10) : "";
    const days = calcDaysDiffFromToday(ymd);
    const lifecycleMeta = getLifecycleByDays(days);
    stat.lastSpendDays = days;
    stat.lifecycle = lifecycleMeta.lifecycle;
    stat.lifecycleLabel = lifecycleMeta.label;
    stat.netStored = stat.totalTopup - stat.totalSpend;
    stat.avgMonthlySpend90 = stat.recent90Spend > 0 ? stat.recent90Spend / 3 : 0;
    stat.balanceCoverageMonths =
      stat.avgMonthlySpend90 > 0 && member
        ? member.balance / stat.avgMonthlySpend90
        : null;

    const itemMap = itemFreqMap.get(memberId);
    if (!itemMap || itemMap.size === 0) {
      stat.favoriteTop1 = "-";
      stat.favoriteTop3 = [];
      return;
    }

    const top = Array.from(itemMap.entries())
      .sort((a, b) => {
        if (a[1].count === b[1].count) {
          return b[1].amount - a[1].amount;
        }
        return b[1].count - a[1].count;
      })
      .slice(0, 3)
      .map(([name]) => name);

    stat.favoriteTop1 = top[0] ?? "-";
    stat.favoriteTop3 = top;
  });

  return map;
}

export function buildGlobalAnalysis(
  filteredTransactions: TransactionRecord[],
  members: Member[],
): GlobalAnalysis {
  let totalSpend = 0;
  let totalTopup = 0;
  let spendCount = 0;
  let topupCount = 0;
  let manualAdjustCount = 0;

  const projectMap = new Map<string, GlobalProjectStat>();
  const memberMap = new Map<string, GlobalMemberStat>();
  const discountMap = new Map<number, number>();
  const memberNameMap = new Map(members.map((member) => [member.member_id, member.name]));

  filteredTransactions.forEach((row) => {
    const currentMember = memberMap.get(row.member_id) ?? {
      memberId: row.member_id,
      memberName: memberNameMap.get(row.member_id) ?? row.member_name_snapshot,
      topup: 0,
      spend: 0,
    };

    if (row.txn_type === "TOPUP") {
      totalTopup += row.net_amount;
      topupCount += 1;
      currentMember.topup += row.net_amount;
      memberMap.set(row.member_id, currentMember);
      return;
    }

    const spendAmount = row.net_amount + (row.external_pay_amount ?? 0);
    totalSpend += spendAmount;
    spendCount += 1;
    currentMember.spend += spendAmount;
    memberMap.set(row.member_id, currentMember);

    if (row.manual_price_adjusted) {
      manualAdjustCount += 1;
    }
    discountMap.set(row.discount_rate, (discountMap.get(row.discount_rate) ?? 0) + 1);

    safeParseItems(row).forEach((item) => {
      const key = item.item_name || item.item_id;
      const old = projectMap.get(key) ?? {
        itemName: key,
        count: 0,
        grossAmount: 0,
      };
      projectMap.set(key, {
        itemName: old.itemName,
        count: old.count + (item.quantity || 1),
        grossAmount: old.grossAmount + item.line_amount,
      });
    });
  });

  return {
    totalSpend,
    totalTopup,
    spendCount,
    topupCount,
    avgTicket: spendCount > 0 ? totalSpend / spendCount : 0,
    netCashflow: totalTopup - totalSpend,
    manualAdjustCount,
    discountDistribution: Array.from(discountMap.entries())
      .map(([discountRate, count]) => ({ discountRate, count }))
      .sort((a, b) => a.discountRate - b.discountRate),
    topProjects: Array.from(projectMap.values())
      .sort((a, b) => {
        if (a.count === b.count) {
          return b.grossAmount - a.grossAmount;
        }
        return b.count - a.count;
      })
      .slice(0, 10),
    topMembersByTopup: Array.from(memberMap.values())
      .sort((a, b) => b.topup - a.topup)
      .slice(0, 10),
    topMembersBySpend: Array.from(memberMap.values())
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 10),
  };
}
