import {
  DEFAULT_CONFIG,
  DEFAULT_PRICE_LIST,
  DEFAULT_STORE_PROFILE,
  withDefaultPriceItemTranslation,
} from "@/lib/local-seed";
import { normalizeCurrencyCode, setPreferredCurrencyCode } from "@/lib/time";
import type {
  CurrencyCode,
  ConfigRules,
  Member,
  PriceItem,
  StoreProfile,
  TransactionRecord,
} from "@/lib/types";

const DB_NAME = "kaboo-cashier-local-db";
const DB_VERSION = 1;

const STORE_PRICE_LIST = "price_list";
const STORE_MEMBERS = "members";
const STORE_TRANSACTIONS = "transactions";
const STORE_CONFIG = "config";
const STORE_META = "meta";

const CONFIG_KEY = "rules";
const STORE_PROFILE_KEY = "store_profile";

export interface LocalMetaRecord<T> {
  key: string;
  value: T;
}

export interface MemberQueryOptions {
  includeInactive?: boolean;
  limit?: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function openDatabase() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PRICE_LIST)) {
        db.createObjectStore(STORE_PRICE_LIST, { keyPath: "item_id" });
      }
      if (!db.objectStoreNames.contains(STORE_MEMBERS)) {
        db.createObjectStore(STORE_MEMBERS, { keyPath: "member_id" });
      }
      if (!db.objectStoreNames.contains(STORE_TRANSACTIONS)) {
        const store = db.createObjectStore(STORE_TRANSACTIONS, { keyPath: "txn_id" });
        store.createIndex("request_id", "request_id", { unique: false });
        store.createIndex("biz_date", "biz_date", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CONFIG)) {
        db.createObjectStore(STORE_CONFIG, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });

  return dbPromise;
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  runner: (store: IDBObjectStore) => Promise<T>,
) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const result = await runner(store);

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });

  return result;
}

async function countRows(storeName: string) {
  return withStore(storeName, "readonly", async (store) => requestToPromise(store.count()));
}

async function seedIfEmpty() {
  const [priceCount, configCount, metaCount] = await Promise.all([
    countRows(STORE_PRICE_LIST),
    countRows(STORE_CONFIG),
    countRows(STORE_META),
  ]);

  if (priceCount === 0) {
    await withStore(STORE_PRICE_LIST, "readwrite", async (store) => {
      for (const item of DEFAULT_PRICE_LIST) {
        store.put(withDefaultPriceItemTranslation(item));
      }
      return undefined;
    });
  } else {
    await withStore(STORE_PRICE_LIST, "readwrite", async (store) => {
      for (const item of DEFAULT_PRICE_LIST) {
        const existing = await requestToPromise(store.get(item.item_id));
        if (!existing) {
          store.put(withDefaultPriceItemTranslation(item));
        }
      }
      const rows = (await requestToPromise(store.getAll())) as PriceItem[];
      rows.forEach((row) => {
        const normalized = withDefaultPriceItemTranslation({
          ...row,
          category_en: row.category_en ?? "",
          item_name_en: row.item_name_en ?? "",
        });
        if (
          normalized.category_en !== row.category_en ||
          normalized.item_name_en !== row.item_name_en
        ) {
          store.put(normalized);
        }
      });
      return undefined;
    });
  }

  if (configCount === 0) {
    await withStore(STORE_CONFIG, "readwrite", async (store) => {
      store.put({ key: CONFIG_KEY, value: DEFAULT_CONFIG });
      return undefined;
    });
  }

  if (metaCount === 0) {
    await withStore(STORE_META, "readwrite", async (store) => {
      store.put({ key: STORE_PROFILE_KEY, value: DEFAULT_STORE_PROFILE });
      return undefined;
    });
  } else {
    await withStore(STORE_META, "readwrite", async (store) => {
      const row = (await requestToPromise(store.get(STORE_PROFILE_KEY))) as
        | LocalMetaRecord<StoreProfile>
        | undefined;
      const normalized = normalizeStoreProfile(row?.value);
      store.put({ key: STORE_PROFILE_KEY, value: normalized });
      return undefined;
    });
  }

}

export async function initLocalDb() {
  await openDatabase();
  await seedIfEmpty();
}

export async function getPriceListLocal() {
  await initLocalDb();
  return withStore(STORE_PRICE_LIST, "readonly", async (store) => {
    const rows = (await requestToPromise(store.getAll()) as PriceItem[]).map((item) =>
      withDefaultPriceItemTranslation({
        ...item,
        category_en: item.category_en ?? "",
        item_name_en: item.item_name_en ?? "",
      }),
    );
    return rows.sort((a, b) => a.category.localeCompare(b.category, "zh-HK"));
  });
}

export async function upsertPriceItemLocal(item: PriceItem) {
  await initLocalDb();
  return withStore(STORE_PRICE_LIST, "readwrite", async (store) => {
    store.put(withDefaultPriceItemTranslation(item));
    return undefined;
  });
}

export async function replacePriceListLocal(items: PriceItem[]) {
  await initLocalDb();
  return withStore(STORE_PRICE_LIST, "readwrite", async (store) => {
    store.clear();
    items.forEach((item) => store.put(withDefaultPriceItemTranslation(item)));
    return undefined;
  });
}

export async function deletePriceItemLocal(itemId: string) {
  await initLocalDb();
  return withStore(STORE_PRICE_LIST, "readwrite", async (store) => {
    store.delete(itemId);
    return undefined;
  });
}

export async function deletePriceItemsByCategoryLocal(category: string) {
  await initLocalDb();
  return withStore(STORE_PRICE_LIST, "readwrite", async (store) => {
    const rows = (await requestToPromise(store.getAll())) as PriceItem[];
    rows
      .filter((item) => item.category === category)
      .forEach((item) => {
        store.delete(item.item_id);
      });
    return undefined;
  });
}

function normalizeMember(member: Member): Member {
  const raw = member as Member & { email?: unknown; manual_locked_discount_rate?: unknown };
  const manualRate = Number(raw.manual_locked_discount_rate);
  return {
    ...raw,
    email: typeof raw.email === "string" ? raw.email : "",
    manual_locked_discount_rate:
      Number.isFinite(manualRate) && manualRate > 0 && manualRate <= 1 ? manualRate : undefined,
    active: member.active ?? true,
  };
}

export async function getMembersLocal(options?: MemberQueryOptions) {
  await initLocalDb();
  return withStore(STORE_MEMBERS, "readonly", async (store) => {
    const rows = (await requestToPromise(store.getAll()) as Member[]).map(normalizeMember);
    const includeInactive = options?.includeInactive ?? false;
    const filtered = includeInactive ? rows : rows.filter((member) => member.active);
    const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name, "zh-HK"));
    const limit = options?.limit;
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      return sorted.slice(0, limit);
    }
    return sorted;
  });
}

export async function searchMembersLocal(keyword: string, options?: MemberQueryOptions) {
  const normalized = keyword.trim().toLowerCase();
  const members = await getMembersLocal(options);
  const limit = options?.limit ?? 50;
  if (!normalized) {
    return members.slice(0, limit);
  }
  return members
    .filter(
      (member) =>
        member.name.toLowerCase().includes(normalized) ||
        member.phone.toLowerCase().includes(normalized),
    )
    .slice(0, limit);
}

export async function getMemberByIdLocal(memberId: string) {
  await initLocalDb();
  return withStore(STORE_MEMBERS, "readonly", async (store) => {
    const row = await requestToPromise(store.get(memberId));
    return row ? normalizeMember(row as Member) : null;
  });
}

export async function upsertMemberLocal(member: Member) {
  await initLocalDb();
  return withStore(STORE_MEMBERS, "readwrite", async (store) => {
    store.put(normalizeMember(member));
    return undefined;
  });
}

export async function updateMemberBalanceLocal(memberId: string, nextBalance: number, updatedAt: string) {
  const member = await getMemberByIdLocal(memberId);
  if (!member) {
    throw new Error("找不到會員，無法更新餘額");
  }

  await upsertMemberLocal({
    ...member,
    balance: nextBalance,
    updated_at: updatedAt,
  });
}

export async function setMemberActiveLocal(memberId: string, active: boolean, updatedAt: string) {
  const member = await getMemberByIdLocal(memberId);
  if (!member) {
    throw new Error("找不到會員");
  }
  await upsertMemberLocal({
    ...member,
    active,
    updated_at: updatedAt,
  });
}

export async function getTransactionsLocal() {
  await initLocalDb();
  return withStore(STORE_TRANSACTIONS, "readonly", async (store) => {
    const rows = await requestToPromise(store.getAll()) as TransactionRecord[];
    return rows.sort((a, b) => {
      if (a.created_at === b.created_at) {
        return a.txn_id.localeCompare(b.txn_id);
      }
      return a.created_at > b.created_at ? -1 : 1;
    });
  });
}

export async function findTransactionsByRequestIdLocal(requestId: string) {
  const rows = await getTransactionsLocal();
  return rows.filter((row) => row.request_id === requestId);
}

export async function appendTransactionsLocal(records: TransactionRecord[]) {
  await initLocalDb();
  await withStore(STORE_TRANSACTIONS, "readwrite", async (store) => {
    records.forEach((row) => store.put(row));
    return undefined;
  });
}

export async function getTransactionByIdLocal(txnId: string) {
  await initLocalDb();
  return withStore(STORE_TRANSACTIONS, "readonly", async (store) => {
    const row = await requestToPromise(store.get(txnId));
    return (row as TransactionRecord | undefined) ?? null;
  });
}

export async function patchTransactionLocal(txnId: string, patch: Partial<TransactionRecord>) {
  const row = await getTransactionByIdLocal(txnId);
  if (!row) {
    throw new Error("找不到流水記錄");
  }
  await withStore(STORE_TRANSACTIONS, "readwrite", async (store) => {
    store.put({
      ...row,
      ...patch,
    });
    return undefined;
  });
}

export async function getConfigLocal() {
  await initLocalDb();
  return withStore(STORE_CONFIG, "readonly", async (store) => {
    const row = await requestToPromise(store.get(CONFIG_KEY));
    const config = (row as LocalMetaRecord<ConfigRules> | undefined)?.value;
    const normalized = normalizeConfigRules(config);
    setPreferredCurrencyCode(normalized.currencyCode);
    return normalized;
  });
}

export async function saveConfigLocal(config: ConfigRules) {
  await initLocalDb();
  const normalized = normalizeConfigRules(config);
  await withStore(STORE_CONFIG, "readwrite", async (store) => {
    store.put({ key: CONFIG_KEY, value: normalized });
    return undefined;
  });
  setPreferredCurrencyCode(normalized.currencyCode);
}

function normalizeConfigRules(config: Partial<ConfigRules> | null | undefined): ConfigRules {
  const tiers = (config?.discountTiers ?? DEFAULT_CONFIG.discountTiers)
    .map((item) => ({
      threshold: Number(item.threshold),
      rate: Number(item.rate),
    }))
    .filter(
      (item) =>
        Number.isFinite(item.threshold) &&
        item.threshold > 0 &&
        Number.isFinite(item.rate) &&
        item.rate > 0 &&
        item.rate <= 1,
    )
    .sort((a, b) => b.threshold - a.threshold);

  const topupQuickAmounts = (config?.topupQuickAmounts ?? DEFAULT_CONFIG.topupQuickAmounts)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.round(value));

  const uniqueQuick = Array.from(new Set(topupQuickAmounts)).sort((a, b) => a - b);
  const currencyCode = normalizeCurrencyCode((config as { currencyCode?: CurrencyCode } | null)?.currencyCode);

  return {
    discountTiers: tiers.length > 0 ? tiers : DEFAULT_CONFIG.discountTiers,
    topupQuickAmounts: uniqueQuick.length > 0 ? uniqueQuick : DEFAULT_CONFIG.topupQuickAmounts,
    currencyCode,
    roundingMode: config?.roundingMode ?? DEFAULT_CONFIG.roundingMode,
    roundingUnit:
      typeof config?.roundingUnit === "number" && Number.isFinite(config.roundingUnit) && config.roundingUnit > 0
        ? config.roundingUnit
        : DEFAULT_CONFIG.roundingUnit,
    allowedPaymentMethods:
      config?.allowedPaymentMethods && config.allowedPaymentMethods.length > 0
        ? config.allowedPaymentMethods
        : DEFAULT_CONFIG.allowedPaymentMethods,
  };
}

function normalizeStoreProfile(profile?: Partial<StoreProfile> | null): StoreProfile {
  return {
    store_name_zh: profile?.store_name_zh?.trim() || DEFAULT_STORE_PROFILE.store_name_zh,
    store_name_en: profile?.store_name_en?.trim() || DEFAULT_STORE_PROFILE.store_name_en,
    address_zh: profile?.address_zh?.trim() || DEFAULT_STORE_PROFILE.address_zh,
    address_en: profile?.address_en?.trim() || DEFAULT_STORE_PROFILE.address_en,
    parking_zh: profile?.parking_zh?.trim() || DEFAULT_STORE_PROFILE.parking_zh,
    parking_en: profile?.parking_en?.trim() || DEFAULT_STORE_PROFILE.parking_en,
    mtr_zh: profile?.mtr_zh?.trim() || DEFAULT_STORE_PROFILE.mtr_zh,
    mtr_en: profile?.mtr_en?.trim() || DEFAULT_STORE_PROFILE.mtr_en,
    phone: profile?.phone?.trim() || DEFAULT_STORE_PROFILE.phone,
    blessing_zh: profile?.blessing_zh?.trim() || DEFAULT_STORE_PROFILE.blessing_zh,
    blessing_en: profile?.blessing_en?.trim() || DEFAULT_STORE_PROFILE.blessing_en,
  };
}

export async function getStoreProfileLocal() {
  await initLocalDb();
  return withStore(STORE_META, "readonly", async (store) => {
    const row = (await requestToPromise(store.get(STORE_PROFILE_KEY))) as
      | LocalMetaRecord<StoreProfile>
      | undefined;
    return normalizeStoreProfile(row?.value);
  });
}

export async function saveStoreProfileLocal(profile: Partial<StoreProfile>) {
  await initLocalDb();
  const normalized = normalizeStoreProfile(profile);
  await withStore(STORE_META, "readwrite", async (store) => {
    store.put({ key: STORE_PROFILE_KEY, value: normalized });
    return undefined;
  });
  return normalized;
}

export async function exportBackupPayload() {
  const [priceList, members, transactions, config, storeProfile] = await Promise.all([
    getPriceListLocal(),
    getMembersLocal({ includeInactive: true, limit: 100000 }),
    getTransactionsLocal(),
    getConfigLocal(),
    getStoreProfileLocal(),
  ]);

  return {
    version: 1,
    exported_at: new Date().toISOString(),
    data: {
      priceList,
      storeProfile,
      members,
      transactions,
      config,
    },
  };
}
