"use client";

import {
  appendTransactionsLocal,
  getConfigLocal,
  getMembersLocal,
  getTransactionsLocal,
  searchMembersLocal,
  setMemberActiveLocal,
  upsertMemberLocal,
} from "@/lib/local-db";
import { executeTopupLocal } from "@/lib/local-transactions";
import { buildMemberStats, type MemberStat } from "@/lib/analytics";
import { getDiscountRate, getDiscountRateByTopupAmount, getLockedDiscountRateFromTransactions } from "@/lib/pricing";
import { formatCurrency, nowHongKong } from "@/lib/time";
import type { ConfigRules, Member, TransactionLineItem, TransactionRecord } from "@/lib/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SortDirection = "asc" | "desc";
type MemberSortColumn =
  | "name"
  | "phone"
  | "gender"
  | "email"
  | "notes"
  | "register_date"
  | "tier"
  | "balance"
  | "total_topup"
  | "total_spend"
  | "last_spend"
  | "favorite";

const DEFAULT_MEMBER_TABLE_COLUMN_ORDER: MemberSortColumn[] = [
  "name",
  "phone",
  "gender",
  "email",
  "notes",
  "register_date",
  "tier",
  "balance",
  "total_topup",
  "total_spend",
  "last_spend",
  "favorite",
];

const MEMBER_COLUMN_ORDER_KEY = "members:column-order:v1";

const MEMBER_COLUMN_LABEL: Record<MemberSortColumn, string> = {
  name: "會員",
  phone: "電話",
  gender: "性別",
  email: "電郵",
  notes: "備註",
  register_date: "註冊日期",
  tier: "會員檔位",
  balance: "餘額",
  total_topup: "累計充值",
  total_spend: "累計消費",
  last_spend: "上次消費",
  favorite: "偏好 Top3",
};

interface MemberForm {
  name: string;
  phone: string;
  email: string;
  balance: string;
  gender: string;
  birthday: string;
  card_no: string;
  wechat_or_whatsapp: string;
  notes: string;
}

const EMPTY_MEMBER_FORM: MemberForm = {
  name: "",
  phone: "",
  email: "",
  balance: "",
  gender: "",
  birthday: "",
  card_no: "",
  wechat_or_whatsapp: "",
  notes: "",
};

const DEMO_MEMBERS: Array<{
  name: string;
  phone: string;
  email: string;
  balance: number;
  gender: string;
  notes: string;
}> = [
  { name: "陳美玲", phone: "62010001", email: "demo001@example.com", balance: 12000, gender: "女", notes: "高頻護理" },
  { name: "黃嘉欣", phone: "62010002", email: "demo002@example.com", balance: 5800, gender: "女", notes: "偏好染髮" },
  { name: "李佩珊", phone: "62010003", email: "demo003@example.com", balance: 3500, gender: "女", notes: "美甲常客" },
  { name: "吳志明", phone: "62010004", email: "demo004@example.com", balance: 1800, gender: "男", notes: "洗剪吹" },
  { name: "周穎芝", phone: "62010005", email: "demo005@example.com", balance: 9800, gender: "女", notes: "睫毛延長" },
  { name: "張可盈", phone: "62010006", email: "demo006@example.com", balance: 2600, gender: "女", notes: "紋繡回訪" },
  { name: "郭小敏", phone: "62010007", email: "demo007@example.com", balance: 900, gender: "女", notes: "偶爾到店" },
  { name: "林慧儀", phone: "62010008", email: "demo008@example.com", balance: 4200, gender: "女", notes: "護理＋染髮" },
  { name: "梁嘉豪", phone: "62010009", email: "demo009@example.com", balance: 1500, gender: "男", notes: "男士修剪" },
  { name: "何雅婷", phone: "62010010", email: "demo010@example.com", balance: 7000, gender: "女", notes: "VIP 測試數據" },
];

const DEMO_ITEM_POOL: Array<{ category: string; item_name: string }> = [
  { category: "染髮系列 COLOR", item_name: "INNOA無氨染 No ammonia" },
  { category: "美甲", item_name: "手純色" },
  { category: "EYELASH EXTENSION", item_name: "設計全眼綜合" },
  { category: "護理系列 Treatment", item_name: "吸金護理 metal-DX" },
  { category: "髮型基礎服務", item_name: "髮型師剪發 Hair cut" },
  { category: "紋繡", item_name: "霧感眉" },
];

const DEMO_SPEND_DAY_PLANS: number[][] = [
  [2, 11, 25],
  [18, 44],
  [96],
  [210],
  [5, 22],
  [38, 79],
  [],
  [130],
  [6, 14],
  [260],
];

const DEMO_SPEND_TOTALS = [4200, 2400, 1600, 1200, 2800, 2200, 0, 1800, 1400, 2000];

function formatYmd(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ymdDaysAgo(daysAgo: number) {
  const base = new Date(`${nowHongKong().bizDate}T00:00:00+08:00`);
  base.setDate(base.getDate() - daysAgo);
  return formatYmd(base);
}

function toIsoFromBiz(ymd: string, hhmm: string) {
  return new Date(`${ymd}T${hhmm}:00+08:00`).toISOString();
}

function getDemoDiscountRate(balanceBefore: number, config?: ConfigRules | null) {
  return getDiscountRate(balanceBefore, config?.discountTiers);
}

function splitSpendAmounts(total: number, count: number) {
  if (count <= 0 || total <= 0) {
    return [] as number[];
  }
  const ratioMap: Record<number, number[]> = {
    1: [1],
    2: [0.6, 0.4],
    3: [0.45, 0.35, 0.2],
    4: [0.35, 0.25, 0.22, 0.18],
  };
  const ratios = ratioMap[count] ?? Array.from({ length: count }, () => 1 / count);
  const amounts: number[] = [];
  let consumed = 0;
  ratios.forEach((ratio, index) => {
    if (index === ratios.length - 1) {
      amounts.push(Math.max(total - consumed, 0));
      return;
    }
    const value = Math.max(Math.round(total * ratio), 0);
    amounts.push(value);
    consumed += value;
  });
  return amounts;
}

function getLifecycleChipClass(days: number | null) {
  if (days === null) {
    return "bg-slate-100 text-slate-600";
  }
  if (days <= 30) {
    return "bg-emerald-100 text-emerald-700";
  }
  if (days <= 90) {
    return "bg-amber-100 text-amber-700";
  }
  return "bg-rose-100 text-rose-700";
}

function rateToTierLabel(rate: number) {
  if (!Number.isFinite(rate) || rate >= 1) return "原價";
  const discount = (rate * 10).toFixed(rate * 10 % 1 === 0 ? 0 : 1);
  return `${discount}折`;
}

function toMemberForm(member: Member | null): MemberForm {
  if (!member) {
    return { ...EMPTY_MEMBER_FORM };
  }
  return {
    name: member.name,
    phone: member.phone,
    email: member.email,
    balance: String(member.balance),
    gender: member.gender,
    birthday: member.birthday,
    card_no: member.card_no,
    wechat_or_whatsapp: member.wechat_or_whatsapp,
    notes: member.notes,
  };
}

function txnsSortedByBizDate(txns: TransactionRecord[]) {
  return txns
    .slice()
    .sort((a, b) => `${a.biz_date} ${a.biz_time}`.localeCompare(`${b.biz_date} ${b.biz_time}`, "zh-HK"));
}

function normalizeColumnOrder(raw: string[] | null | undefined) {
  if (!raw || raw.length === 0) {
    return DEFAULT_MEMBER_TABLE_COLUMN_ORDER;
  }
  const valid = new Set<MemberSortColumn>(DEFAULT_MEMBER_TABLE_COLUMN_ORDER);
  const cleaned = raw.filter((key): key is MemberSortColumn => valid.has(key as MemberSortColumn));
  const unique: MemberSortColumn[] = [];
  cleaned.forEach((key) => {
    if (!unique.includes(key)) {
      unique.push(key);
    }
  });
  DEFAULT_MEMBER_TABLE_COLUMN_ORDER.forEach((key) => {
    if (!unique.includes(key)) {
      unique.push(key);
    }
  });
  return unique;
}

export default function MembersPanel() {
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [sortColumn, setSortColumn] = useState<MemberSortColumn>("balance");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [showForm, setShowForm] = useState(false);
  const [showColumnSettings, setShowColumnSettings] = useState(false);
  const [columnOrder, setColumnOrder] = useState<MemberSortColumn[]>(DEFAULT_MEMBER_TABLE_COLUMN_ORDER);

  const [results, setResults] = useState<Member[]>([]);
  const [allTransactions, setAllTransactions] = useState<TransactionRecord[]>([]);
  const [configRules, setConfigRules] = useState<ConfigRules | null>(null);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [form, setForm] = useState<MemberForm>(EMPTY_MEMBER_FORM);
  const [history, setHistory] = useState<TransactionRecord[]>([]);
  const [historyFilter, setHistoryFilter] = useState<"ALL" | "TOPUP" | "SPEND">("ALL");
  const [topupAmount, setTopupAmount] = useState(500);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const searchRequestSeq = useRef(0);

  const loadMembersAndTransactions = useCallback(
    async (keyword: string, keepMemberId: string | null = null) => {
      const requestId = ++searchRequestSeq.current;
      setLoading(true);
      setError("");
      try {
        const [members, txns, config] = await Promise.all([
          searchMembersLocal(keyword, { includeInactive: showInactive, limit: 500 }),
          getTransactionsLocal(),
          getConfigLocal(),
        ]);

        if (requestId !== searchRequestSeq.current) {
          return;
        }

        setResults(members);
        setAllTransactions(txns);
        setConfigRules(config);

        if (!keepMemberId) {
          return;
        }
        const nextSelected = members.find((member) => member.member_id === keepMemberId) ?? null;
        setSelectedMember(nextSelected);
        setForm(toMemberForm(nextSelected));
        setHistory(nextSelected ? txns.filter((row) => row.member_id === nextSelected.member_id) : []);
      } catch (fetchError) {
        if (requestId === searchRequestSeq.current) {
          setError(fetchError instanceof Error ? fetchError.message : "讀取會員失敗");
        }
      } finally {
        if (requestId === searchRequestSeq.current) {
          setLoading(false);
        }
      }
    },
    [showInactive],
  );

  useEffect(() => {
    loadMembersAndTransactions("", null).catch(() => {
      // ignore
    });
  }, [loadMembersAndTransactions]);

  useEffect(() => {
    if (!selectedMember) {
      setHistory([]);
      return;
    }
    setHistory(allTransactions.filter((row) => row.member_id === selectedMember.member_id));
  }, [allTransactions, selectedMember]);

  useEffect(() => {
    try {
      const text = localStorage.getItem(MEMBER_COLUMN_ORDER_KEY);
      if (!text) return;
      const parsed = JSON.parse(text) as string[];
      setColumnOrder(normalizeColumnOrder(parsed));
    } catch {
      // ignore broken local storage
    }
  }, []);

  const filteredHistory = useMemo(() => {
    if (historyFilter === "ALL") return history;
    return history.filter((row) => row.txn_type === historyFilter);
  }, [history, historyFilter]);

  const memberStats = useMemo(() => buildMemberStats(results, allTransactions), [results, allTransactions]);
  const tierRateMap = useMemo(() => {
    const map = new Map<string, number>();
    results.forEach((member) => {
      map.set(
        member.member_id,
        getLockedDiscountRateFromTransactions(
          member.member_id,
          member.balance,
          allTransactions,
          configRules?.discountTiers,
          0,
        ),
      );
    });
    return map;
  }, [results, allTransactions, configRules]);

  const quickTopupOptions = useMemo(() => {
    const options = configRules?.topupQuickAmounts ?? [1500, 3000, 5000, 10000];
    return options.slice().sort((a, b) => a - b);
  }, [configRules]);

  const sortedResults = useMemo(() => {
    const rows = results.slice();

    rows.sort((a, b) => {
      const statA = memberStats.get(a.member_id);
      const statB = memberStats.get(b.member_id);
      const tierA = rateToTierLabel(tierRateMap.get(a.member_id) ?? 1);
      const tierB = rateToTierLabel(tierRateMap.get(b.member_id) ?? 1);

      let compare = 0;
      if (sortColumn === "name") {
        compare = a.name.localeCompare(b.name, "zh-HK");
      } else if (sortColumn === "phone") {
        compare = a.phone.localeCompare(b.phone, "zh-HK");
      } else if (sortColumn === "gender") {
        compare = (a.gender || "").localeCompare(b.gender || "", "zh-HK");
      } else if (sortColumn === "email") {
        compare = (a.email || "").localeCompare(b.email || "", "zh-HK");
      } else if (sortColumn === "notes") {
        compare = (a.notes || "").localeCompare(b.notes || "", "zh-HK");
      } else if (sortColumn === "register_date") {
        compare = (a.register_date || "").localeCompare(b.register_date || "", "zh-HK");
      } else if (sortColumn === "tier") {
        compare = tierA.localeCompare(tierB, "zh-HK");
      } else if (sortColumn === "balance") {
        compare = a.balance - b.balance;
      } else if (sortColumn === "total_topup") {
        compare = (statA?.totalTopup ?? 0) - (statB?.totalTopup ?? 0);
      } else if (sortColumn === "total_spend") {
        compare = (statA?.totalSpend ?? 0) - (statB?.totalSpend ?? 0);
      } else if (sortColumn === "last_spend") {
        compare = (statA?.lastSpendAt ?? "").localeCompare(statB?.lastSpendAt ?? "", "zh-HK");
      } else if (sortColumn === "favorite") {
        compare = (statA?.favoriteTop1 ?? "").localeCompare(statB?.favoriteTop1 ?? "", "zh-HK");
      }

      if (compare === 0) {
        compare = a.name.localeCompare(b.name, "zh-HK");
      }
      return sortDirection === "asc" ? compare : -compare;
    });
    return rows;
  }, [results, memberStats, sortColumn, sortDirection, tierRateMap]);

  const bigCustomerIds = useMemo(() => {
    const topupTop3 = results
      .slice()
      .sort(
        (a, b) =>
          (memberStats.get(b.member_id)?.totalTopup ?? 0) -
          (memberStats.get(a.member_id)?.totalTopup ?? 0),
      )
      .slice(0, 3)
      .map((member) => member.member_id);
    const idSet = new Set(topupTop3);
    results.forEach((member) => {
      if (member.balance >= 5000) {
        idSet.add(member.member_id);
      }
    });
    return idSet;
  }, [results, memberStats]);

  const selectedStat = selectedMember
    ? memberStats.get(selectedMember.member_id)
    : undefined;
  const selectedIsBigCustomer = selectedMember ? bigCustomerIds.has(selectedMember.member_id) : false;

  const selectedChartData = useMemo(() => {
    if (!selectedMember) {
      return {
        recent30: [] as Array<{ label: string; topup: number; spend: number }>,
        balanceTrend180: [] as Array<{ label: string; value: number }>,
        favoriteTop5: [] as Array<{ label: string; amount: number; count: number }>,
      };
    }

    const sortedHistory = txnsSortedByBizDate(
      history.filter((row) => row.member_id === selectedMember.member_id),
    );

    const recent30 = Array.from({ length: 6 }, (_, bucketIndex) => {
      const rangeEndDaysAgo = (5 - bucketIndex) * 5;
      const rangeStartDaysAgo = rangeEndDaysAgo + 4;
      const rangeStart = ymdDaysAgo(rangeStartDaysAgo);
      const rangeEnd = ymdDaysAgo(rangeEndDaysAgo);
      let topup = 0;
      let spend = 0;

      sortedHistory.forEach((txn) => {
        if (txn.biz_date < rangeStart || txn.biz_date > rangeEnd) return;
        if (txn.txn_type === "TOPUP") topup += txn.net_amount;
        if (txn.txn_type === "SPEND") spend += txn.net_amount;
      });

      return {
        label: `${rangeStart.slice(5)}~${rangeEnd.slice(5)}`,
        topup,
        spend,
      };
    });

    const trendCutoff = ymdDaysAgo(179);
    const trendRows = sortedHistory.filter((txn) => txn.biz_date >= trendCutoff);
    const balanceTrend180: Array<{ label: string; value: number }> = [];
    if (trendRows.length > 0) {
      balanceTrend180.push({
        label: `${trendRows[0].biz_date.slice(5)} 起`,
        value: trendRows[0].balance_before,
      });
      trendRows.forEach((txn) => {
        balanceTrend180.push({
          label: txn.biz_date.slice(5),
          value: txn.balance_after,
        });
      });
    }

    const favoriteMap = new Map<string, { amount: number; count: number }>();
    sortedHistory.forEach((txn) => {
      if (txn.txn_type !== "SPEND" || !txn.items_json) return;
      try {
        const items = JSON.parse(txn.items_json) as TransactionLineItem[];
        items.forEach((item) => {
          const key = `${item.category}｜${item.item_name}`;
          const prev = favoriteMap.get(key) ?? { amount: 0, count: 0 };
          const amount = Number(item.line_amount || 0);
          const qty = Number(item.quantity || 0);
          favoriteMap.set(key, {
            amount: prev.amount + (Number.isFinite(amount) ? amount : 0),
            count: prev.count + (Number.isFinite(qty) && qty > 0 ? qty : 1),
          });
        });
      } catch {
        // ignore broken legacy json
      }
    });

    const favoriteTop5 = Array.from(favoriteMap.entries())
      .map(([label, value]) => ({ label, ...value }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    return { recent30, balanceTrend180, favoriteTop5 };
  }, [history, selectedMember]);

  function toggleColumnSort(column: MemberSortColumn) {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortColumn(column);
    setSortDirection(column === "balance" || column === "total_topup" || column === "total_spend" ? "desc" : "asc");
  }

  function renderSortMark(column: MemberSortColumn) {
    if (sortColumn !== column) {
      return "↕";
    }
    return sortDirection === "asc" ? "↑" : "↓";
  }

  function moveColumn(column: MemberSortColumn, direction: "left" | "right") {
    setColumnOrder((prev) => {
      const index = prev.indexOf(column);
      if (index === -1) return prev;
      const target = direction === "left" ? index - 1 : index + 1;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const temp = next[target];
      next[target] = next[index];
      next[index] = temp;
      localStorage.setItem(MEMBER_COLUMN_ORDER_KEY, JSON.stringify(next));
      return next;
    });
  }

  function resetColumnOrder() {
    setColumnOrder(DEFAULT_MEMBER_TABLE_COLUMN_ORDER);
    localStorage.setItem(
      MEMBER_COLUMN_ORDER_KEY,
      JSON.stringify(DEFAULT_MEMBER_TABLE_COLUMN_ORDER),
    );
  }

  function columnCellClass(column: MemberSortColumn) {
    if (column === "balance" || column === "total_topup" || column === "total_spend") {
      return "px-2 py-2 text-right tabular-nums text-slate-700";
    }
    return "px-2 py-2 text-slate-600";
  }

  function clearSelection() {
    setSelectedMember(null);
    setHistory([]);
    setForm({ ...EMPTY_MEMBER_FORM });
    setMessage("");
    setError("");
  }

  function toggleCreateForm() {
    if (showForm && !selectedMember) {
      setShowForm(false);
      return;
    }
    clearSelection();
    setShowForm(true);
  }

  async function searchMembers() {
    await loadMembersAndTransactions(query, selectedMember?.member_id ?? null);
  }

  async function selectMember(member: Member) {
    if (selectedMember?.member_id === member.member_id) {
      clearSelection();
      setShowForm(false);
      return;
    }
    setSelectedMember(member);
    setForm(toMemberForm(member));
    setHistory(allTransactions.filter((row) => row.member_id === member.member_id));
    setShowForm(true);
    setMessage("");
    setError("");
  }

  async function saveMember() {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const trimmedName = form.name.trim();
      const trimmedPhone = form.phone.trim();
      const balanceText = form.balance.trim();

      if (!trimmedName) {
        throw new Error("請輸入會員姓名");
      }
      if (!trimmedPhone) {
        throw new Error("請輸入會員電話");
      }
      if (balanceText === "") {
        throw new Error("請輸入餘額");
      }
      const balance = Number(balanceText);
      if (!Number.isFinite(balance) || balance < 0) {
        throw new Error("餘額格式不正確");
      }

      const isCreate = !selectedMember;
      const nowInfo = nowHongKong();
      const now = nowInfo.createdAt;
      const todayBizDate = nowInfo.bizDate;
      const payload: Member = {
        member_id: selectedMember?.member_id ?? crypto.randomUUID(),
        name: trimmedName,
        phone: trimmedPhone,
        email: form.email.trim(),
        balance,
        active: selectedMember?.active ?? true,
        gender: form.gender.trim(),
        birthday: form.birthday.trim(),
        card_no: form.card_no.trim(),
        wechat_or_whatsapp: form.wechat_or_whatsapp.trim(),
        register_date: selectedMember?.register_date || todayBizDate,
        created_at: selectedMember?.created_at || now,
        updated_at: now,
        notes: form.notes.trim(),
      };
      await upsertMemberLocal(payload);

      if (isCreate) {
        clearSelection();
        setShowForm(false);
        setMessage("新增會員成功");
        await loadMembersAndTransactions(query, null);
      } else {
        setMessage("會員保存成功");
        await loadMembersAndTransactions(query, payload.member_id);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失敗");
    } finally {
      setLoading(false);
    }
  }

  async function topupMember() {
    if (!selectedMember) {
      setError("請先選會員");
      return;
    }
    if (!selectedMember.active) {
      setError("已刪除會員不可充值，請先恢復");
      return;
    }
    if (topupAmount <= 0) {
      setError("請輸入有效充值金額");
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");
    try {
      await executeTopupLocal({
        request_id: crypto.randomUUID(),
        member_id: selectedMember.member_id,
        amount: Number(topupAmount),
        source_device: window.innerWidth > 768 ? "iPad" : "Phone",
      });
      setMessage("充值成功");
      await loadMembersAndTransactions(query, selectedMember.member_id);
    } catch (topupError) {
      setError(topupError instanceof Error ? topupError.message : "充值失敗");
    } finally {
      setLoading(false);
    }
  }

  async function deactivateMember() {
    if (!selectedMember) {
      return;
    }
    const ok = window.confirm(`確定刪除會員「${selectedMember.name}」？可在已刪除列表恢復。`);
    if (!ok) {
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");
    try {
      await setMemberActiveLocal(selectedMember.member_id, false, nowHongKong().createdAt);
      setMessage("會員已刪除（軟刪除）");
      if (showInactive) {
        await loadMembersAndTransactions(query, selectedMember.member_id);
      } else {
        clearSelection();
        setShowForm(false);
        await loadMembersAndTransactions(query, null);
      }
    } catch (deactivateError) {
      setError(deactivateError instanceof Error ? deactivateError.message : "刪除失敗");
    } finally {
      setLoading(false);
    }
  }

  async function reactivateMember() {
    if (!selectedMember) {
      return;
    }
    setLoading(true);
    setError("");
    setMessage("");
    try {
      await setMemberActiveLocal(selectedMember.member_id, true, nowHongKong().createdAt);
      setMessage("會員已恢復");
      await loadMembersAndTransactions(query, selectedMember.member_id);
    } catch (reactivateError) {
      setError(reactivateError instanceof Error ? reactivateError.message : "恢復失敗");
    } finally {
      setLoading(false);
    }
  }

  async function addDemoMembers() {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const [existingMembers, allTxns] = await Promise.all([
        getMembersLocal({ includeInactive: true, limit: 10000 }),
        getTransactionsLocal(),
      ]);
      const existingPhones = new Set(existingMembers.map((member) => member.phone.trim()));
      const memberByPhone = new Map(existingMembers.map((member) => [member.phone.trim(), member]));
      const now = nowHongKong().createdAt;
      const registerDate = now.slice(0, 10);
      let created = 0;
      let generatedTxns = 0;

      for (const preset of DEMO_MEMBERS) {
        if (existingPhones.has(preset.phone)) {
          continue;
        }
        const payload: Member = {
          member_id: crypto.randomUUID(),
          name: preset.name,
          phone: preset.phone,
          email: preset.email,
          balance: preset.balance,
          active: true,
          gender: preset.gender,
          birthday: "",
          card_no: "",
          wechat_or_whatsapp: "",
          register_date: registerDate,
          created_at: now,
          updated_at: now,
          notes: preset.notes,
        };
        await upsertMemberLocal(payload);
        memberByPhone.set(payload.phone, payload);
        existingPhones.add(preset.phone);
        created += 1;
      }

      const existingTxnMemberIds = new Set(
        allTxns
          .map((txn) => txn.member_id)
          .filter((memberId) => Boolean(memberId)),
      );
      const newTxnRecords: TransactionRecord[] = [];

      DEMO_MEMBERS.forEach((preset, index) => {
        const member = memberByPhone.get(preset.phone);
        if (!member) {
          return;
        }
        if (existingTxnMemberIds.has(member.member_id)) {
          return;
        }

        const dayPlan = DEMO_SPEND_DAY_PLANS[index] ?? [];
        const spendTotal = DEMO_SPEND_TOTALS[index] ?? 0;
        const amounts = splitSpendAmounts(spendTotal, dayPlan.length);
        const topupTotal = member.balance + spendTotal;
        const topupDay = dayPlan.length > 0 ? Math.max(...dayPlan) + 7 : 30 + index * 3;
        const topupDate = ymdDaysAgo(topupDay);
        const topupBizTime = "10:15";
        let runningBalance = 0;

        const topupTxn: TransactionRecord = {
          txn_id: crypto.randomUUID(),
          request_id: `demo-seed-${crypto.randomUUID()}`,
          txn_type: "TOPUP",
          created_at: toIsoFromBiz(topupDate, topupBizTime),
          biz_date: topupDate,
          biz_time: topupBizTime,
          member_id: member.member_id,
          member_name_snapshot: member.name,
          customer_gender: member.gender === "男" ? "男" : member.gender === "女" ? "女" : undefined,
          items_json: "",
          gross_amount: topupTotal,
          discount_rate: 1,
          net_amount: topupTotal,
          external_pay_amount: 0,
          settlement_mode: "TOPUP",
          pricing_basis: "share_price",
          manual_price_adjusted: false,
          payment_method: "BALANCE",
          balance_before: 0,
          balance_after: topupTotal,
          notes: "測試會員初始化充值",
          discount_reason: "",
          source_device: "iPad",
        };
        newTxnRecords.push(topupTxn);
        runningBalance = topupTotal;

        const sortedDays = dayPlan.slice().sort((a, b) => b - a);
        sortedDays.forEach((daysAgo, spendIdx) => {
          const spendAmount = amounts[spendIdx] ?? 0;
          if (spendAmount <= 0 || runningBalance <= 0) {
            return;
          }
          const bizDate = ymdDaysAgo(daysAgo);
          const bizTime = ["12:20", "15:45", "18:10", "20:00"][spendIdx % 4];
          const item = DEMO_ITEM_POOL[(index + spendIdx) % DEMO_ITEM_POOL.length];
          const discountRate = getDemoDiscountRate(runningBalance, configRules);
          const grossAmount = discountRate > 0 ? Math.round(spendAmount / discountRate) : spendAmount;
          const lineItems: TransactionLineItem[] = [
            {
              item_id: `demo-item-${index}-${spendIdx}`,
              item_name: item.item_name,
              category: item.category,
              quantity: 1,
              unit_source: "share",
              unit_price: grossAmount,
              line_amount: grossAmount,
              manual_input: false,
            },
          ];
          const before = runningBalance;
          const after = Math.max(before - spendAmount, 0);
          const spendTxn: TransactionRecord = {
            txn_id: crypto.randomUUID(),
            request_id: `demo-seed-${crypto.randomUUID()}`,
            txn_type: "SPEND",
            created_at: toIsoFromBiz(bizDate, bizTime),
            biz_date: bizDate,
            biz_time: bizTime,
            member_id: member.member_id,
            member_name_snapshot: member.name,
            customer_gender: member.gender === "男" ? "男" : member.gender === "女" ? "女" : undefined,
            items_json: JSON.stringify(lineItems),
            gross_amount: grossAmount,
            discount_rate: discountRate,
            net_amount: spendAmount,
            external_pay_amount: 0,
            settlement_mode: "FULL_BALANCE",
            pricing_basis: "share_price",
            manual_price_adjusted: false,
            payment_method: "BALANCE",
            balance_before: before,
            balance_after: after,
            notes: "測試會員消費流水",
            discount_reason: "",
            source_device: "iPad",
          };
          newTxnRecords.push(spendTxn);
          runningBalance = after;
        });

        existingTxnMemberIds.add(member.member_id);
      });

      if (newTxnRecords.length > 0) {
        await appendTransactionsLocal(newTxnRecords);
        generatedTxns = newTxnRecords.length;
      }

      if (created === 0 && generatedTxns === 0) {
        setMessage("測試會員與測試流水已存在，未新增");
      } else {
        setMessage(`已新增 ${created} 位測試會員，補入 ${generatedTxns} 筆測試流水`);
      }
      await loadMembersAndTransactions(query, selectedMember?.member_id ?? null);
    } catch (seedError) {
      setError(seedError instanceof Error ? seedError.message : "新增測試會員失敗");
    } finally {
      setLoading(false);
    }
  }

  function renderMemberCell(
    member: Member,
    stat: MemberStat | undefined,
    tierRate: number,
    column: MemberSortColumn,
  ) {
    if (column === "name") {
      return (
        <>
          <p className="font-semibold text-slate-900">{member.name}</p>
          <p className="truncate text-xs text-slate-500">{member.notes || "無備註"}</p>
        </>
      );
    }
    if (column === "phone") {
      return (
        <>
          <p>{member.phone}</p>
          <p className="truncate text-xs text-slate-500">{member.wechat_or_whatsapp || "-"}</p>
        </>
      );
    }
    if (column === "gender") return member.gender || "-";
    if (column === "email") return member.email || "-";
    if (column === "notes") return member.notes || "-";
    if (column === "register_date") return member.register_date || "-";
    if (column === "tier") {
      return (
        <span className="rounded bg-cyan-50 px-1.5 py-0.5 text-[11px] font-semibold text-cyan-700">
          {rateToTierLabel(tierRate)}
        </span>
      );
    }
    if (column === "balance") return formatCurrency(member.balance);
    if (column === "total_topup") return formatCurrency(stat?.totalTopup ?? 0);
    if (column === "total_spend") return formatCurrency(stat?.totalSpend ?? 0);
    if (column === "last_spend") {
      return (
        <>
          <p>{stat?.lastSpendAt || "-"}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            <span
              className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                getLifecycleChipClass(stat?.lastSpendDays ?? null)
              }`}
            >
              {stat?.lifecycleLabel ?? "從未消費"}
            </span>
            {bigCustomerIds.has(member.member_id) && member.active && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">
                尊貴客戶
              </span>
            )}
            {!member.active && (
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-semibold text-slate-700">
                已刪除
              </span>
            )}
          </div>
        </>
      );
    }
    return stat?.favoriteTop3?.length ? stat.favoriteTop3.join(" / ") : "-";
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="姓名/電話"
            className="h-10 min-w-[220px] flex-1 rounded-lg border border-slate-200 px-3"
          />
          <button
            type="button"
            onClick={searchMembers}
            disabled={loading}
            className="h-10 rounded-lg bg-cyan-700 px-4 text-sm font-semibold text-white"
          >
            搜尋
          </button>
          <button
            type="button"
            onClick={toggleCreateForm}
            className="h-10 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white"
          >
            {showForm && !selectedMember ? "收起新增" : "+ 新增會員"}
          </button>
          {false && (
            <button
              type="button"
              onClick={addDemoMembers}
              disabled={loading}
              className="h-10 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white disabled:opacity-60"
            >
              加入測試會員
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              clearSelection();
              setShowForm(false);
            }}
            className="h-10 rounded-lg bg-slate-200 px-4 text-sm font-semibold text-slate-700"
          >
            清除選中
          </button>
          <button
            type="button"
            onClick={() => setShowColumnSettings((prev) => !prev)}
            className="h-10 rounded-lg bg-slate-200 px-4 text-sm font-semibold text-slate-700"
          >
            {showColumnSettings ? "收起欄位順序" : "欄位順序"}
          </button>
          <span className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
            點表頭可升降序
          </span>
          <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(event) => setShowInactive(event.target.checked)}
            />
            顯示已刪除
          </label>
        </div>
      </section>

      {showForm && !selectedMember && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-900">新增會員</h2>
            <span className="text-xs font-semibold text-slate-500">
              註冊日期將自動使用今天：{nowHongKong().bizDate}
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="姓名*"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.phone}
              onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))}
              placeholder="電話*"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.email}
              onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
              placeholder="電郵（可選）"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              type="number"
              inputMode="decimal"
              value={form.balance}
              onChange={(event) => setForm((prev) => ({ ...prev, balance: event.target.value }))}
              placeholder="餘額*"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.gender}
              onChange={(event) => setForm((prev) => ({ ...prev, gender: event.target.value }))}
              placeholder="性別"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.birthday}
              onChange={(event) => setForm((prev) => ({ ...prev, birthday: event.target.value }))}
              placeholder="生日 YYYY-MM-DD"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.card_no}
              onChange={(event) => setForm((prev) => ({ ...prev, card_no: event.target.value }))}
              placeholder="卡號"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.wechat_or_whatsapp}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, wechat_or_whatsapp: event.target.value }))
              }
              placeholder="微信/WhatsApp"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.notes}
              onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
              placeholder="備註"
              className="h-10 rounded-lg border border-slate-200 px-3 md:col-span-2"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveMember}
              disabled={loading}
              className="h-10 rounded-lg bg-cyan-700 px-4 text-sm font-semibold text-white disabled:opacity-60"
            >
              保存
            </button>
          </div>
        </section>
      )}

      <section className="rounded-2xl bg-white p-2 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-1">
          <p className="text-xs text-slate-500">
            尊貴客戶標記規則：充值總額 Top3 或當前餘額 ≥ {formatCurrency(5000)}
          </p>
          <button
            type="button"
            onClick={resetColumnOrder}
            className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
          >
            還原欄位順序
          </button>
        </div>
        {showColumnSettings && (
          <div className="mx-2 mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
            <p className="mb-2 text-xs font-semibold text-slate-700">欄位順序（可左右調整）</p>
            <div className="flex flex-wrap gap-2">
              {columnOrder.map((column, index) => (
                <div key={column} className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1">
                  <span className="text-xs text-slate-600">{index + 1}. {MEMBER_COLUMN_LABEL[column]}</span>
                  <button
                    type="button"
                    onClick={() => moveColumn(column, "left")}
                    disabled={index === 0}
                    className="rounded bg-slate-100 px-1 text-xs text-slate-700 disabled:opacity-40"
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    onClick={() => moveColumn(column, "right")}
                    disabled={index === columnOrder.length - 1}
                    className="rounded bg-slate-100 px-1 text-xs text-slate-700 disabled:opacity-40"
                  >
                    →
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="max-h-[720px] overflow-auto">
          <table className="min-w-[1480px] w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-slate-600">
              <tr>
                {columnOrder.map((column) => (
                  <th
                    key={column}
                    className={`px-2 py-2 font-semibold ${
                      column === "balance" || column === "total_topup" || column === "total_spend"
                        ? "text-right"
                        : "text-left"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleColumnSort(column)}
                      className="inline-flex items-center gap-1"
                    >
                      {MEMBER_COLUMN_LABEL[column]} <span className="text-xs">{renderSortMark(column)}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedResults.map((member) => {
                const stat = memberStats.get(member.member_id);
                const tierRate = tierRateMap.get(member.member_id) ?? 1;
                const selected = selectedMember?.member_id === member.member_id;
                return (
                  <tr
                    key={member.member_id}
                    onClick={() => selectMember(member)}
                    className={`cursor-pointer border-t border-slate-100 ${
                      selected ? "bg-cyan-50" : "hover:bg-slate-50"
                    }`}
                  >
                    {columnOrder.map((column) => (
                      <td key={`${member.member_id}-${column}`} className={columnCellClass(column)}>
                        {renderMemberCell(member, stat, tierRate, column)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {showForm && selectedMember && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-900">
              編輯會員：{selectedMember.name}
            </h2>
            <span className="text-xs font-semibold text-slate-500">
              {selectedMember.active ? "有效會員" : "已刪除會員"}
            </span>
          </div>
          <div className="mb-2 text-xs text-slate-500">
            註冊日期：{selectedMember.register_date || "-"}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="姓名*"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.phone}
              onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))}
              placeholder="電話*"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.email}
              onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
              placeholder="電郵（可選）"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              type="number"
              inputMode="decimal"
              value={form.balance}
              onChange={(event) => setForm((prev) => ({ ...prev, balance: event.target.value }))}
              placeholder="餘額*"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.gender}
              onChange={(event) => setForm((prev) => ({ ...prev, gender: event.target.value }))}
              placeholder="性別"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.birthday}
              onChange={(event) => setForm((prev) => ({ ...prev, birthday: event.target.value }))}
              placeholder="生日 YYYY-MM-DD"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.card_no}
              onChange={(event) => setForm((prev) => ({ ...prev, card_no: event.target.value }))}
              placeholder="卡號"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.wechat_or_whatsapp}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, wechat_or_whatsapp: event.target.value }))
              }
              placeholder="微信/WhatsApp"
              className="h-10 rounded-lg border border-slate-200 px-3"
            />
            <input
              value={form.notes}
              onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
              placeholder="備註"
              className="h-10 rounded-lg border border-slate-200 px-3 md:col-span-2"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveMember}
              disabled={loading}
              className="h-10 rounded-lg bg-cyan-700 px-4 text-sm font-semibold text-white disabled:opacity-60"
            >
              保存
            </button>
            {selectedMember?.active && (
              <button
                type="button"
                onClick={deactivateMember}
                disabled={loading}
                className="h-10 rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white disabled:opacity-60"
              >
                刪除會員
              </button>
            )}
            {selectedMember && !selectedMember.active && (
              <button
                type="button"
                onClick={reactivateMember}
                disabled={loading}
                className="h-10 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-60"
              >
                恢復會員
              </button>
            )}
          </div>
        </section>
      )}

      {selectedMember && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-4">
            <div className="rounded-lg bg-slate-50 p-2">
              <p className="text-xs text-slate-500">上次消費</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-1">
                <p className="text-sm font-semibold text-slate-900">
                  {selectedStat?.lastSpendAt || "-"}
                </p>
                <span
                  className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                    getLifecycleChipClass(selectedStat?.lastSpendDays ?? null)
                  }`}
                >
                  {selectedStat?.lifecycleLabel ?? "從未消費"}
                </span>
                {selectedIsBigCustomer && selectedMember.active && (
                  <span className="inline-flex rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">
                    尊貴客戶
                  </span>
                )}
                {!selectedMember.active && (
                  <span className="inline-flex rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-semibold text-slate-700">
                    已刪除
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 p-2">
              <p className="text-xs text-slate-500">充值總額</p>
              <p className="text-sm font-semibold text-slate-900">
                {formatCurrency(selectedStat?.totalTopup ?? 0)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-2">
              <p className="text-xs text-slate-500">消費總額</p>
              <p className="text-sm font-semibold text-slate-900">
                {formatCurrency(selectedStat?.totalSpend ?? 0)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-2">
              <p className="text-xs text-slate-500">淨儲值（充-消）</p>
              <p className="text-sm font-semibold text-slate-900">
                {formatCurrency(selectedStat?.netStored ?? 0)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-2">
              <p className="text-xs text-slate-500">近30天消費</p>
              <p className="text-sm font-semibold text-slate-900">
                {formatCurrency(selectedStat?.recent30Spend ?? 0)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-2">
              <p className="text-xs text-slate-500">近90天消費</p>
              <p className="text-sm font-semibold text-slate-900">
                {formatCurrency(selectedStat?.recent90Spend ?? 0)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-2">
              <p className="text-xs text-slate-500">90天月均消費</p>
              <p className="text-sm font-semibold text-slate-900">
                {formatCurrency(selectedStat?.avgMonthlySpend90 ?? 0)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-2">
              <p className="text-xs text-slate-500">餘額可支撐</p>
              <p className="text-sm font-semibold text-slate-900">
                {(selectedStat?.balanceCoverageMonths ?? null) === null
                  ? "-"
                  : (selectedStat?.balanceCoverageMonths ?? 0) > 99
                    ? "99+ 月"
                    : `${(selectedStat?.balanceCoverageMonths ?? 0).toFixed(1)} 月`}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-2">
              <p className="text-xs text-slate-500">消費次數</p>
              <p className="text-sm font-semibold text-slate-900">
                {selectedStat?.spendCount ?? 0}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-2">
              <p className="text-xs text-slate-500">最常做項目</p>
              <p className="text-sm font-semibold text-slate-900">
                {selectedStat?.favoriteTop1 ?? "-"}
              </p>
            </div>
          </div>

          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700">
            經營建議：{
              selectedStat?.lifecycle === "ACTIVE"
                ? "目前活躍，建議維持回訪節奏，重點推高毛利護理組合。"
                : selectedStat?.lifecycle === "WARM"
                  ? "近期降溫，建議7天內主動關懷，提供次回訪小套餐。"
                  : selectedStat?.lifecycle === "RISK" || selectedStat?.lifecycle === "DORMANT"
                    ? "流失風險偏高，建議以常做項目做喚回優惠，先促成一次回店。"
                    : "尚未形成消費習慣，建議先做首單體驗價，建立首次消費。"
            }
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p className="w-full text-xs text-slate-500">
              快捷充值（會員檔位）：
              {(configRules?.discountTiers ?? [])
                .slice()
                .sort((a, b) => a.threshold - b.threshold)
                .map((tier) => `>=${tier.threshold}（${rateToTierLabel(tier.rate)}）`)
                .join(" / ")}
              ；也可手動輸入任意金額。
            </p>
            <button
              type="button"
              onClick={() => setTopupAmount(0)}
              className={`h-9 rounded-lg px-3 text-sm font-semibold ${
                topupAmount === 0 ? "bg-cyan-700 text-white" : "bg-slate-100 text-slate-700"
              }`}
            >
              不充值
            </button>
            {quickTopupOptions.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTopupAmount(value)}
                className={`h-9 rounded-lg px-3 text-sm font-semibold ${
                  topupAmount === value ? "bg-cyan-700 text-white" : "bg-slate-100 text-slate-700"
                }`}
              >
                充值{value}（
                {rateToTierLabel(getDiscountRateByTopupAmount(value, configRules?.discountTiers))}
                ）
              </button>
            ))}
            <input
              type="number"
              inputMode="decimal"
              value={topupAmount}
              onChange={(event) => setTopupAmount(Number(event.target.value || "0"))}
              placeholder="手動充值"
              className="h-9 w-36 rounded-lg border border-slate-200 px-2 text-sm"
            />
            <button
              type="button"
              onClick={topupMember}
              disabled={loading}
              className="h-9 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              提交充值
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">消費情況分析</h3>
          </div>
          <div className="mt-2 grid gap-2 lg:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <p className="text-xs font-semibold text-slate-700">最近30天 充值 vs 消費</p>
              <div className="mt-2 h-36">
                {selectedChartData.recent30.some((row) => row.topup > 0 || row.spend > 0) ? (
                  (() => {
                    const maxValue = Math.max(
                      ...selectedChartData.recent30.flatMap((row) => [row.topup, row.spend]),
                      1,
                    );
                    const yTicks = [1, 0.75, 0.5, 0.25, 0].map((ratio) =>
                      Math.round(maxValue * ratio),
                    );
                    return (
                      <div className="flex h-full gap-2">
                        <div className="flex h-[108px] flex-col justify-between text-[10px] text-slate-500">
                          {yTicks.map((value, index) => (
                            <span key={`member-chart-y-${index}`} className="tabular-nums">
                              {formatCurrency(value)}
                            </span>
                          ))}
                        </div>
                        <div className="relative flex-1">
                          <div className="absolute inset-0 flex flex-col justify-between">
                            {yTicks.map((_, index) => (
                              <div key={`member-chart-grid-${index}`} className="border-t border-dashed border-slate-200" />
                            ))}
                          </div>
                          <div className="relative flex h-full items-end gap-1">
                            {selectedChartData.recent30.map((row) => {
                              const topupHeight = Math.max((row.topup / maxValue) * 100, row.topup > 0 ? 6 : 0);
                              const spendHeight = Math.max((row.spend / maxValue) * 100, row.spend > 0 ? 6 : 0);
                              return (
                                <div key={row.label} className="flex flex-1 flex-col items-center justify-end gap-1">
                                  <div className="flex h-[108px] w-full items-end justify-center gap-1">
                                    <div
                                      className="w-2 rounded-t bg-emerald-500"
                                      style={{ height: `${topupHeight}%` }}
                                      title={`${row.label} 充值 ${formatCurrency(row.topup)}`}
                                    />
                                    <div
                                      className="w-2 rounded-t bg-cyan-600"
                                      style={{ height: `${spendHeight}%` }}
                                      title={`${row.label} 消費 ${formatCurrency(row.spend)}`}
                                    />
                                  </div>
                                  <p className="text-[10px] text-slate-500">{row.label.slice(0, 5)}</p>
                                </div>
                              );
                            })}
                          </div>
                          <p className="mt-0.5 text-[10px] text-slate-500">X軸：日期區間　Y軸：金額（HKD）</p>
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-500">
                    最近30天暫無充值/消費數據
                  </div>
                )}
              </div>
              <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-600">
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded bg-emerald-500" />充值
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded bg-cyan-600" />消費
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <p className="text-xs font-semibold text-slate-700">最近180天 餘額趨勢</p>
              <div className="mt-2 h-36">
                {selectedChartData.balanceTrend180.length > 1 ? (
                  <svg viewBox="0 0 320 130" className="h-full w-full">
                    {(() => {
                      const points = selectedChartData.balanceTrend180;
                      const min = Math.min(...points.map((p) => p.value));
                      const max = Math.max(...points.map((p) => p.value), min + 1);
                      const stepX = points.length === 1 ? 0 : 250 / (points.length - 1);
                      const yTicks = [1, 0.75, 0.5, 0.25, 0].map((ratio) => min + (max - min) * ratio);
                      const path = points
                        .map((point, idx) => {
                          const x = 56 + idx * stepX;
                          const y = 108 - ((point.value - min) / (max - min)) * 92;
                          return `${x},${y}`;
                        })
                        .join(" ");
                      return (
                        <>
                          {yTicks.map((tick, idx) => {
                            const y = 108 - ((tick - min) / (max - min)) * 92;
                            return (
                              <g key={`member-trend-grid-${idx}`}>
                                <line x1="56" y1={y} x2="306" y2={y} stroke="#cbd5e1" strokeDasharray="2 3" />
                                <text x="4" y={y + 3} fontSize="9" fill="#64748b">
                                  {`HK$${Math.round(tick).toLocaleString("zh-HK")}`}
                                </text>
                              </g>
                            );
                          })}
                          <line x1="56" y1="108" x2="306" y2="108" stroke="#94a3b8" />
                          <polyline fill="none" stroke="#0891b2" strokeWidth="2.5" points={path} />
                          {points.map((point, idx) => {
                            const x = 56 + idx * stepX;
                            const y = 108 - ((point.value - min) / (max - min)) * 92;
                            return <circle key={`${point.label}-${idx}`} cx={x} cy={y} r="2.2" fill="#0f172a" />;
                          })}
                          <text x="56" y="122" fontSize="9" fill="#64748b">
                            {points[0]?.label || ""}
                          </text>
                          <text x="282" y="122" fontSize="9" fill="#64748b">
                            {points[points.length - 1]?.label || ""}
                          </text>
                          <text x="132" y="122" fontSize="9" fill="#64748b">
                            X軸：日期
                          </text>
                          <text x="8" y="12" fontSize="9" fill="#64748b">
                            Y軸：餘額
                          </text>
                        </>
                      );
                    })()}
                  </svg>
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-500">
                    最近180天交易太少，暫無趨勢線
                  </div>
                )}
              </div>
              <p className="text-[11px] text-slate-500">起點=區間第一筆交易前餘額，終點=最近餘額</p>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <p className="text-xs font-semibold text-slate-700">偏好項目 Top5（按消費額）</p>
              <div className="mt-2 space-y-1">
                {selectedChartData.favoriteTop5.length > 0 ? (
                  (() => {
                    const maxAmount = Math.max(...selectedChartData.favoriteTop5.map((row) => row.amount), 1);
                    return selectedChartData.favoriteTop5.map((row) => {
                      const widthPct = Math.max((row.amount / maxAmount) * 100, 8);
                      return (
                        <div key={row.label} className="space-y-0.5">
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <p className="truncate text-slate-700">{row.label}</p>
                            <p className="tabular-nums text-slate-600">{formatCurrency(row.amount)}</p>
                          </div>
                          <div className="h-2 rounded bg-slate-200">
                            <div className="h-2 rounded bg-violet-500" style={{ width: `${widthPct}%` }} />
                          </div>
                        </div>
                      );
                    });
                  })()
                ) : (
                  <div className="flex h-28 items-center justify-center text-xs text-slate-500">
                    暫無可分析的消費項目
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">會員流水</h3>
            <select
              value={historyFilter}
              onChange={(event) => setHistoryFilter(event.target.value as "ALL" | "TOPUP" | "SPEND")}
              className="h-8 rounded-lg border border-slate-200 px-2 text-sm"
            >
              <option value="ALL">全部</option>
              <option value="TOPUP">充值</option>
              <option value="SPEND">消費</option>
            </select>
          </div>
          <div className="mt-2 max-h-[260px] overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-2 py-2 text-left">時間</th>
                  <th className="px-2 py-2 text-left">類型</th>
                  <th className="px-2 py-2 text-right">金額</th>
                  <th className="px-2 py-2 text-left">餘額變化</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.map((row) => (
                  <tr key={row.txn_id} className="border-t border-slate-100">
                    <td className="px-2 py-2">{row.biz_date} {row.biz_time}</td>
                    <td className="px-2 py-2">{row.txn_type === "TOPUP" ? "充值" : "消費"}</td>
                    <td className="px-2 py-2 text-right">{formatCurrency(row.net_amount)}</td>
                    <td className="px-2 py-2">
                      {formatCurrency(row.balance_before)} → {formatCurrency(row.balance_after)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {message && <p className="text-sm font-semibold text-emerald-700">{message}</p>}
      {error && <p className="text-sm font-semibold text-rose-700">{error}</p>}
    </div>
  );
}
