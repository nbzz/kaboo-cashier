import { NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { z } from "zod";

const receiptSchema = z.object({
  lang: z.enum(["zh", "en"]).optional().default("zh"),
  to_email: z.string().email(),
  member_name: z.string().min(1),
  biz_date: z.string().min(10),
  biz_time: z.string().min(4),
  gross_amount: z.number().nonnegative(),
  member_deduct_amount: z.number().nonnegative(),
  external_pay_amount: z.number().nonnegative(),
  extra_discount_amount: z.number().nonnegative().default(0),
  floor_discount_amount: z.number().nonnegative().default(0),
  total_payable_amount: z.number().nonnegative(),
  discount_rate: z.number().positive().max(1),
  balance_before_topup: z.number().nonnegative(),
  topup_amount: z.number().nonnegative(),
  balance_before_deduct: z.number().nonnegative(),
  balance_after: z.number(),
  notes: z.string().optional(),
  store_profile: z
    .object({
      store_name_zh: z.string().optional(),
      store_name_en: z.string().optional(),
      address_zh: z.string().optional(),
      address_en: z.string().optional(),
      parking_zh: z.string().optional(),
      parking_en: z.string().optional(),
      mtr_zh: z.string().optional(),
      mtr_en: z.string().optional(),
      phone: z.string().optional(),
      blessing_zh: z.string().optional(),
      blessing_en: z.string().optional(),
    })
    .optional(),
  items: z
    .array(
      z.object({
        item_id: z.string().optional(),
        item_name: z.string().min(1),
        item_name_en: z.string().optional(),
        category: z.string().optional().default(""),
        category_en: z.string().optional(),
        quantity: z.number().int().positive(),
        unit_price: z.number().nonnegative(),
        line_amount: z.number().nonnegative(),
      }),
    )
    .min(1),
});

function money(value: number) {
  return `HK$${value.toLocaleString("zh-HK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function t(lang: "zh" | "en", zh: string, en: string) {
  return lang === "en" ? en : zh;
}

function escapeHtml(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? "465");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.BACKUP_FROM_EMAIL ?? user;
  if (!host || !port || !user || !pass || !from) {
    throw new Error("Missing SMTP env configuration");
  }
  return { host, port, user, pass, from };
}

function buildHtml(parsed: z.infer<typeof receiptSchema>) {
  const lang = parsed.lang ?? "zh";
  const profile = parsed.store_profile ?? {};
  const storeNameZh = profile.store_name_zh?.trim() || "示例美業店";
  const storeNameEn = profile.store_name_en?.trim() || storeNameZh;
  const addressZh = profile.address_zh?.trim() || "請在系統設定填寫店舖地址";
  const addressEn = profile.address_en?.trim() || addressZh;
  const parkingZh = profile.parking_zh?.trim() || "請在系統設定填寫最近停車位";
  const parkingEn = profile.parking_en?.trim() || parkingZh;
  const mtrZh = profile.mtr_zh?.trim() || "請在系統設定填寫最近地鐵資訊";
  const mtrEn = profile.mtr_en?.trim() || mtrZh;
  const phone = profile.phone?.trim() || "請在系統設定填寫電話";
  const blessingZh = profile.blessing_zh?.trim() || "多謝你今日幫襯，祝你靚住每一日！";
  const blessingEn = profile.blessing_en?.trim() || blessingZh;
  const memberSavings = Math.max(parsed.gross_amount - parsed.total_payable_amount, 0);
  const hasExtraPay = parsed.external_pay_amount > 0;
  const hasExtraDiscount = parsed.extra_discount_amount > 0;
  const hasFloorDiscount = parsed.floor_discount_amount > 0;
  const hasTopup = parsed.topup_amount > 0;
  const itemRows = parsed.items
    .map((item) => {
      const categoryZh = item.category || "未分類";
      const categoryEn = item.category_en?.trim() || categoryZh;
      const itemEn = item.item_name_en?.trim() || item.item_name;
      const categoryText = lang === "en" ? categoryEn : categoryZh;
      const itemText = lang === "en" ? itemEn : item.item_name;
      return `
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;">
            <div style="font-size:12px;color:#64748b;">${escapeHtml(categoryText)}</div>
            <div style="margin-top:2px;">${escapeHtml(itemText)} x${item.quantity}</div>
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;">${money(item.unit_price)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;">${money(item.line_amount)}</td>
        </tr>`;
    })
    .join("");

  const notesBlock = parsed.notes?.trim()
    ? `<p style="margin:12px 0 0;color:#475569;"><strong>${t(lang, "備註", "Notes")}:</strong> ${escapeHtml(parsed.notes.trim())}</p>`
    : "";

  return `
    <div style="background:#f1f5f9;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
      <div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #dbe5ef;border-radius:14px;overflow:hidden;">
        <div style="padding:18px 20px;background:#155e75;color:#ffffff;">
          <h2 style="margin:0;font-size:20px;line-height:1.3;">${t(lang, "今日消費記錄", "Today Receipt")}</h2>
          <p style="margin:8px 0 0;font-size:14px;opacity:0.95;">${escapeHtml(parsed.biz_date)} ${escapeHtml(parsed.biz_time)} ｜ ${escapeHtml(parsed.member_name)}</p>
        </div>
        <div style="padding:18px 20px;background:#ffffff;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
            <thead>
              <tr style="background:#f8fafc;color:#334155;">
                <th style="padding:10px 8px;text-align:left;">${t(lang, "項目", "Item")}</th>
                <th style="padding:10px 8px;text-align:right;">${t(lang, "單價", "Unit")}</th>
                <th style="padding:10px 8px;text-align:right;">${t(lang, "小計", "Subtotal")}</th>
              </tr>
            </thead>
            <tbody>${itemRows}</tbody>
          </table>
          <div style="margin-top:14px;padding:12px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;">${t(lang, "折前金額", "Gross")}：<strong>${money(parsed.gross_amount)}</strong></p>
            <p style="margin:0 0 4px;">${t(lang, "折扣", "Discount")}：<strong>${(parsed.discount_rate * 100).toFixed(0)}%</strong></p>
            ${
              hasExtraPay
                ? `<p style="margin:0 0 4px;">${t(lang, "另收金額", "Extra Pay")}：<strong>${money(parsed.external_pay_amount)}</strong></p>`
                : ""
            }
            ${
              hasFloorDiscount
                ? `<p style="margin:0 0 4px;">${t(lang, "去小數優惠", "Floor Discount")}：<strong>${money(parsed.floor_discount_amount)}</strong></p>`
                : ""
            }
            ${
              hasExtraDiscount
                ? `<p style="margin:0 0 4px;">${t(lang, "額外優惠", "Extra Discount")}：<strong>${money(parsed.extra_discount_amount)}</strong></p>`
                : ""
            }
            ${
              hasTopup
                ? `<p style="margin:0 0 4px;">${t(lang, "本次充值", "Top-up")}：<strong>${money(parsed.topup_amount)}</strong></p>`
                : ""
            }
            <p style="margin:0 0 4px;">${t(lang, "原餘額", "Original Balance")}：<strong>${money(parsed.balance_before_topup)}</strong></p>
            <p style="margin:0 0 4px;">${t(lang, "今日消費", "Today's Spend")}：<strong>${money(parsed.total_payable_amount)}</strong></p>
            <p style="margin:6px 0 0;font-size:16px;color:${parsed.balance_after < 0 ? "#be123c" : "#047857"};">
              ${t(lang, "扣款後餘額", "Balance After")}：<strong>${money(parsed.balance_after)}</strong>
            </p>
            <p style="margin:4px 0 0;">${t(lang, "會員卡本單已省", "Member Saved")}：<strong>${money(memberSavings)}</strong></p>
          </div>
          ${notesBlock}
          <div style="margin-top:14px;padding:12px;border-radius:10px;background:#ffffff;border:1px solid #e2e8f0;">
            <p style="margin:0 0 6px;font-weight:700;">${escapeHtml(lang === "en" ? storeNameEn : storeNameZh)}</p>
            <p style="margin:0 0 4px;color:#334155;">${t(lang, "地址", "Address")}：${escapeHtml(lang === "en" ? addressEn : addressZh)}</p>
            <p style="margin:0 0 4px;color:#334155;">${t(lang, "停車", "Parking")}：${escapeHtml(lang === "en" ? parkingEn : parkingZh)}</p>
            <p style="margin:0 0 4px;color:#334155;">${t(lang, "地鐵", "MTR")}：${escapeHtml(lang === "en" ? mtrEn : mtrZh)}</p>
            <p style="margin:0;color:#334155;">${t(lang, "電話", "Tel")}：${escapeHtml(phone)}</p>
          </div>
          <p style="margin:14px 0 0;color:#0f766e;font-weight:600;">${t(
            lang,
            blessingZh,
            blessingEn,
          )}</p>
        </div>
      </div>
    </div>`;
}

export async function POST(request: Request) {
  try {
    const parsed = receiptSchema.parse(await request.json());
    const smtp = getSmtpConfig();
    const storeNameZh = parsed.store_profile?.store_name_zh?.trim() || "示例美業店";
    const storeNameEn = parsed.store_profile?.store_name_en?.trim() || storeNameZh;
    const addressZh =
      parsed.store_profile?.address_zh?.trim() || "請在系統設定填寫店舖地址";
    const addressEn = parsed.store_profile?.address_en?.trim() || addressZh;
    const parkingZh = parsed.store_profile?.parking_zh?.trim() || "請在系統設定填寫最近停車位";
    const parkingEn = parsed.store_profile?.parking_en?.trim() || parkingZh;
    const mtrZh = parsed.store_profile?.mtr_zh?.trim() || "請在系統設定填寫最近地鐵資訊";
    const mtrEn = parsed.store_profile?.mtr_en?.trim() || mtrZh;
    const phone = parsed.store_profile?.phone?.trim() || "請在系統設定填寫電話";
    const blessingZh =
      parsed.store_profile?.blessing_zh?.trim() || "多謝你今日幫襯，祝你靚住每一日！";
    const blessingEn = parsed.store_profile?.blessing_en?.trim() || blessingZh;

    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: {
        user: smtp.user,
        pass: smtp.pass,
      },
    });

    await transporter.sendMail({
      from: smtp.from,
      to: parsed.to_email,
      subject:
        parsed.lang === "en"
          ? `${storeNameEn} | Today Receipt | ${parsed.biz_date} ${parsed.member_name}`
          : `${storeNameZh}｜今日消費記錄｜${parsed.biz_date} ${parsed.member_name}`,
      html: buildHtml(parsed),
      text:
        parsed.lang === "en"
          ? [
              `Member: ${parsed.member_name}`,
              `Time: ${parsed.biz_date} ${parsed.biz_time}`,
              `Gross: ${money(parsed.gross_amount)}`,
              `Discount: ${(parsed.discount_rate * 100).toFixed(0)}%`,
              ...(parsed.external_pay_amount > 0
                ? [`Extra Pay: ${money(parsed.external_pay_amount)}`]
                : []),
              ...(parsed.floor_discount_amount > 0
                ? [`Floor Discount: ${money(parsed.floor_discount_amount)}`]
                : []),
              ...(parsed.extra_discount_amount > 0
                ? [`Extra Discount: ${money(parsed.extra_discount_amount)}`]
                : []),
              ...(parsed.topup_amount > 0 ? [`Top-up: ${money(parsed.topup_amount)}`] : []),
              `Original Balance: ${money(parsed.balance_before_topup)}`,
              `Today's Spend: ${money(parsed.total_payable_amount)}`,
              `Balance After: ${money(parsed.balance_after)}`,
              `Member Saved: ${money(Math.max(parsed.gross_amount - parsed.total_payable_amount, 0))}`,
              "",
              "Items:",
              ...parsed.items.map((item) => {
                const category = item.category_en?.trim() || item.category || "未分類";
                const itemName = item.item_name_en?.trim() || item.item_name;
                return `${category} | ${itemName} x${item.quantity} ${money(item.line_amount)}`;
              }),
              "",
              storeNameEn,
              `Address: ${addressEn}`,
              `Parking: ${parkingEn}`,
              `MTR: ${mtrEn}`,
              `Tel: ${phone}`,
              "",
              blessingEn,
            ].join("\n")
          : [
              `會員：${parsed.member_name}`,
              `時間：${parsed.biz_date} ${parsed.biz_time}`,
              `折前金額：${money(parsed.gross_amount)}`,
              `折扣：${(parsed.discount_rate * 100).toFixed(0)}%`,
              ...(parsed.external_pay_amount > 0
                ? [`另收金額：${money(parsed.external_pay_amount)}`]
                : []),
              ...(parsed.floor_discount_amount > 0
                ? [`去小數優惠：${money(parsed.floor_discount_amount)}`]
                : []),
              ...(parsed.extra_discount_amount > 0
                ? [`額外優惠：${money(parsed.extra_discount_amount)}`]
                : []),
              ...(parsed.topup_amount > 0 ? [`本次充值：${money(parsed.topup_amount)}`] : []),
              `原餘額：${money(parsed.balance_before_topup)}`,
              `今日消費：${money(parsed.total_payable_amount)}`,
              `扣款後餘額：${money(parsed.balance_after)}`,
              `會員卡本單已省：${money(Math.max(parsed.gross_amount - parsed.total_payable_amount, 0))}`,
              "",
              "項目：",
              ...parsed.items.map((item) => {
                const category = item.category || "未分類";
                return `${category} | ${item.item_name} x${item.quantity} ${money(item.line_amount)}`;
              }),
              "",
              storeNameZh,
              `地址：${addressZh}`,
              `停車：${parkingZh}`,
              `地鐵：${mtrZh}`,
              `電話：${phone}`,
              "",
              blessingZh,
            ].join("\n"),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "member-receipt-email-failed",
      },
      { status: 400 },
    );
  }
}
