export type TxnType = "TOPUP" | "SPEND";

export type PricingBasis = "share_price" | "original_price";

export type SourceDevice = "iPad" | "Phone";

export type RoundingMode = "ROUND" | "CEIL" | "FLOOR";

export type PaymentMethod = "BALANCE";

export type CurrencyCode = "HKD" | "CNY" | "USD" | "EUR" | "GBP" | "JPY" | "SGD" | "AUD";

export interface PriceItem {
  item_id: string;
  category: string;
  category_en?: string;
  item_name: string;
  item_name_en?: string;
  original_price: string;
  share_price: string;
  active: boolean;
  notes: string;
}

export interface StoreProfile {
  store_name_zh: string;
  store_name_en: string;
  address_zh: string;
  address_en: string;
  parking_zh: string;
  parking_en: string;
  mtr_zh: string;
  mtr_en: string;
  phone: string;
  blessing_zh: string;
  blessing_en: string;
}

export interface Member {
  member_id: string;
  name: string;
  phone: string;
  email: string;
  balance: number;
  active: boolean;
  gender: string;
  birthday: string;
  card_no: string;
  wechat_or_whatsapp: string;
  register_date: string;
  created_at: string;
  updated_at: string;
  notes: string;
}

export interface TransactionLineItem {
  item_id: string;
  item_name: string;
  category: string;
  quantity: number;
  unit_source: "share" | "original" | "manual";
  unit_price: number;
  line_amount: number;
  manual_input: boolean;
}

export interface TransactionRecord {
  txn_id: string;
  request_id: string;
  txn_type: TxnType;
  created_at: string;
  biz_date: string;
  biz_time: string;
  member_id: string;
  member_name_snapshot: string;
  customer_gender?: "女" | "男";
  items_json: string;
  gross_amount: number;
  discount_rate: number;
  net_amount: number;
  external_pay_amount?: number;
  extra_discount_amount?: number;
  floor_discount_amount?: number;
  settlement_mode?: "FULL_BALANCE" | "PARTIAL_BALANCE" | "WALKIN_ORIGINAL" | "TOPUP";
  pricing_basis: PricingBasis;
  manual_price_adjusted: boolean;
  payment_method: PaymentMethod;
  balance_before: number;
  balance_after: number;
  notes: string;
  discount_reason: string;
  source_device: SourceDevice;
  reversal_of_txn_id?: string;
  reversed_by_txn_id?: string;
}

export interface DiscountTier {
  threshold: number;
  rate: number;
}

export interface ConfigRules {
  discountTiers: DiscountTier[];
  topupQuickAmounts: number[];
  currencyCode: CurrencyCode;
  roundingMode: RoundingMode;
  roundingUnit: number;
  allowedPaymentMethods: PaymentMethod[];
}

export interface SheetRow {
  __rowNumber: number;
  [key: string]: string | number;
}

export const PRICE_LIST_COLUMNS = [
  "item_id",
  "category",
  "item_name",
  "original_price",
  "share_price",
  "active",
  "notes",
] as const;

export const MEMBER_COLUMNS = [
  "member_id",
  "name",
  "phone",
  "email",
  "balance",
  "active",
  "gender",
  "birthday",
  "card_no",
  "wechat_or_whatsapp",
  "register_date",
  "created_at",
  "updated_at",
  "notes",
] as const;

export const TRANSACTION_COLUMNS = [
  "txn_id",
  "request_id",
  "txn_type",
  "created_at",
  "biz_date",
  "biz_time",
  "member_id",
  "member_name_snapshot",
  "customer_gender",
  "items_json",
  "gross_amount",
  "discount_rate",
  "net_amount",
  "external_pay_amount",
  "extra_discount_amount",
  "floor_discount_amount",
  "settlement_mode",
  "pricing_basis",
  "manual_price_adjusted",
  "payment_method",
  "balance_before",
  "balance_after",
  "notes",
  "discount_reason",
  "source_device",
] as const;

export const CONFIG_COLUMNS = ["key", "value", "notes"] as const;

export type PriceListColumn = (typeof PRICE_LIST_COLUMNS)[number];
export type MemberColumn = (typeof MEMBER_COLUMNS)[number];
export type TransactionColumn = (typeof TRANSACTION_COLUMNS)[number];
export type ConfigColumn = (typeof CONFIG_COLUMNS)[number];
