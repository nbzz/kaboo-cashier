export type ItemDisplayLanguage = "zh" | "en";

const CATEGORY_EN_MAP: Record<string, string> = {
  "EYELASH EXTENSION": "EYELASH EXTENSION",
  "MISS EYE DOR VIP高級訂製系列": "MISS EYE DOR VIP Signature Series",
  "TREATMENT（眼部治療）": "EYE TREATMENT",
  "紋繡": "Semi-Permanent Makeup",
  "美甲": "Nail Services",
  "髮型基礎服務": "Hair Basic Services",
  "染髮系列 COLOR": "Hair Color Series",
  "護理系列 Treatment": "Hair Treatment Series",
  "未分類": "Uncategorized",
};

const ITEM_EN_BY_ID: Record<string, string> = {
  lash_001: "Lightweight Upper Lash Extension",
  lash_002: "Full Eye Design Set",
  lash_003: "European Style Design",
  vip_001: "Japanese Lash",
  vip_002: "Japanese-European Lash",
  treatment_eye_001: "Deep Eye Cleansing",
  embroidery_001: "Misty Brow",
  embroidery_002: "Wild Stroke Brow",
  embroidery_003: "Brow Gap Fill",
  embroidery_004: "Misty Eyeliner",
  embroidery_005: "Natural Lip Blush",
  embroidery_006: "Non-Invasive Brow Removal",
  nail_001: "Hand Solid Color",
  nail_002: "Basic Style",
  nail_003: "Hand Painting",
  nail_004: "Nail Extension",
  nail_005: "Foot Care",
  hair_001: "Stylist Haircut",
  hair_002: "Stylist Wash & Blow",
  hair_003: "Washing Blow Dry",
  color_001: "INNOA No Ammonia",
  color_002: "L'oreal Color",
  color_003: "Highlights",
  color_004: "Toner",
  hair_treatment_001: "L'oreal Deep Nourishing Mask",
  hair_treatment_002: "L'oreal",
  hair_treatment_003: "Metal-DX Treatment",
  hair_treatment_004: "Kerastase Chronologiste Treatment",
  hair_treatment_005: "L'oreal Scalp Treatment",
};

const ITEM_EN_BY_NAME: Record<string, string> = {
  "輕盈上眼睫毛": "Lightweight Upper Lash Extension",
  "設計全眼綜合": "Full Eye Design Set",
  "歐美設計": "European Style Design",
  "日式睫毛": "Japanese Lash",
  "日式歐美睫毛": "Japanese-European Lash",
  "眼部深層清潔": "Deep Eye Cleansing",
  "霧感眉": "Misty Brow",
  "野生線條眉": "Wild Stroke Brow",
  "補/缺": "Brow Gap Fill",
  "霧感眼線": "Misty Eyeliner",
  "裸唇感": "Natural Lip Blush",
  "無創洗眉": "Non-Invasive Brow Removal",
  "手純色": "Hand Solid Color",
  "基礎款": "Basic Style",
  "手繪": "Hand Painting",
  "延長": "Nail Extension",
  "腳部護理": "Foot Care",
  "髮型師剪發 Hair cut": "Stylist Haircut",
  "髮型師洗吹": "Stylist Wash & Blow",
  "Washing blow dry": "Washing Blow Dry",
  "INNOA無氨染 No ammonia": "INNOA No Ammonia",
  "歐萃雅 L'oreal": "L'oreal Color",
  "挑染 highlights": "Highlights",
  "水霧染 (toner)": "Toner",
  "歐萃雅深層滋養發膜": "L'oreal Deep Nourishing Mask",
  "L'oreal": "L'oreal",
  "吸金護理 metal-DX": "Metal-DX Treatment",
  "卡詩角子醬護理 Kerastase Chronological Treatment": "Kerastase Chronologiste Treatment",
  "歐萃雅頭皮清潔發膜 Scalp Treatment": "L'oreal Scalp Treatment",
};

export function getCategoryDisplayName(
  category: string,
  language: ItemDisplayLanguage,
) {
  if (language === "zh") {
    return category;
  }
  return CATEGORY_EN_MAP[category] ?? category;
}

export function getItemDisplayName(
  itemName: string,
  language: ItemDisplayLanguage,
  itemId?: string,
) {
  if (language === "zh") {
    return itemName;
  }
  if (itemId && ITEM_EN_BY_ID[itemId]) {
    return ITEM_EN_BY_ID[itemId];
  }
  return ITEM_EN_BY_NAME[itemName] ?? itemName;
}
