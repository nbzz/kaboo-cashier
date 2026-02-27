"use client";

import type { AnalysisRange } from "@/lib/analytics";
import { runDailyBackup } from "@/lib/backup-client";
import {
  getDefaultBackupMailSettings,
  loadBackupMailSettings,
  saveBackupMailSettings,
  type BackupMailSettings,
} from "@/lib/backup-settings";
import { getMembersLocal, upsertMemberLocal } from "@/lib/local-db";
import { exportMemberImportTemplateWorkbook, exportMemberLedgerWorkbook } from "@/lib/member-ledger-export";
import { exportStoreLedgerWorkbook } from "@/lib/store-ledger-export";
import { nowHongKong } from "@/lib/time";
import type { Member } from "@/lib/types";
import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";

const RANGE_OPTIONS: Array<{ value: AnalysisRange; label: string }> = [
  { value: "WEEK", label: "本周" },
  { value: "30D", label: "最近30天" },
  { value: "QUARTER", label: "最近一季度" },
  { value: "365D", label: "最近365天" },
  { value: "ALL", label: "所有" },
];

function normalizeHeaderKey(value: string) {
  return value.replace(/\s+/g, "").replace(/[()（）]/g, "").toLowerCase();
}

function getCell(row: Record<string, unknown>, aliases: string[]) {
  const normalized = new Map<string, string>();
  Object.entries(row).forEach(([key, value]) => {
    normalized.set(normalizeHeaderKey(key), String(value ?? "").trim());
  });
  for (const alias of aliases) {
    const hit = normalized.get(normalizeHeaderKey(alias));
    if (hit !== undefined) {
      return hit;
    }
  }
  return "";
}

function parseActiveValue(input: string, fallback = true) {
  const raw = input.trim();
  if (!raw) {
    return fallback;
  }
  if (["啟用", "启用", "是", "1", "true", "TRUE", "有效"].includes(raw)) {
    return true;
  }
  if (["停用", "禁用", "否", "0", "false", "FALSE", "已刪除", "已删除"].includes(raw)) {
    return false;
  }
  return fallback;
}

function parseManualTierRate(input: string, rowNo: number) {
  const raw = input.trim();
  if (!raw) {
    return undefined;
  }
  if (raw === "原價" || raw === "原价") {
    return 1;
  }
  const match = raw.match(/^(\d+(?:\.\d+)?)折$/);
  if (!match) {
    throw new Error(`第 ${rowNo} 行：當前折扣檔位格式錯誤，請填 7.5折`);
  }
  const fold = Number(match[1]);
  if (!Number.isFinite(fold) || fold <= 0 || fold > 10) {
    throw new Error(`第 ${rowNo} 行：當前折扣檔位超出範圍，請填 1折 到 10折`);
  }
  return fold / 10;
}

export default function SyncPanel() {
  const [message, setMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [exportingMember, setExportingMember] = useState(false);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const [importingMember, setImportingMember] = useState(false);
  const [exportingStore, setExportingStore] = useState(false);
  const [storeRange, setStoreRange] = useState<AnalysisRange>("30D");
  const [smtpSettings, setSmtpSettings] = useState<BackupMailSettings>(getDefaultBackupMailSettings);
  const memberImportInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setSmtpSettings(loadBackupMailSettings());
  }, []);

  async function manualSync() {
    setSyncing(true);
    setMessage("");
    try {
      const normalized = saveBackupMailSettings(smtpSettings);
      setSmtpSettings(normalized);
      const result = await runDailyBackup(true);
      if (result === "success") {
        setMessage("數據同步完成，已寄送會員與店鋪流水 Excel");
      } else if (result === "missing-config") {
        setMessage("請先填好 SMTP、發件人和收件人，再同步");
      } else {
        setMessage("同步失敗，已加入同步重試佇列");
      }
    } catch {
      setMessage("同步失敗，稍後會自動重試");
    } finally {
      setSyncing(false);
    }
  }

  function saveSmtpConfig() {
    const normalized = saveBackupMailSettings(smtpSettings);
    setSmtpSettings(normalized);
    setMessage("郵件配置已保存");
  }

  async function exportMemberExcel() {
    setExportingMember(true);
    setMessage("");
    try {
      await exportMemberLedgerWorkbook();
      setMessage("已導出會員總覽與會員流水 Excel");
    } catch {
      setMessage("會員 Excel 導出失敗，請重試");
    } finally {
      setExportingMember(false);
    }
  }

  async function downloadMemberTemplate() {
    setDownloadingTemplate(true);
    setMessage("");
    try {
      await exportMemberImportTemplateWorkbook();
      setMessage("已下載會員導入模板");
    } catch {
      setMessage("模板下載失敗，請重試");
    } finally {
      setDownloadingTemplate(false);
    }
  }

  async function importMemberExcel(file: File) {
    setImportingMember(true);
    setMessage("");
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: "array" });
      const preferredSheet =
        ["導入模板_會員", "會員導入", "会员导入", "會員資料"].find((name) =>
          workbook.SheetNames.includes(name),
        ) ?? workbook.SheetNames[0];
      if (!preferredSheet) {
        throw new Error("Excel 內沒有可讀取的工作表");
      }
      const sheet = workbook.Sheets[preferredSheet];
      if (!sheet) {
        throw new Error("找不到會員導入工作表");
      }
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      if (rows.length === 0) {
        throw new Error("導入內容為空，請檢查 Excel");
      }

      const now = nowHongKong().createdAt;
      const today = now.slice(0, 10);
      const existingMembers = await getMembersLocal({ includeInactive: true, limit: 100000 });
      const memberByPhone = new Map(existingMembers.map((member) => [member.phone.trim(), member]));

      let created = 0;
      let updated = 0;
      let skipped = 0;

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const rowNo = i + 2;
        const joined = Object.values(row)
          .map((value) => String(value ?? "").trim())
          .join("");
        if (!joined) {
          continue;
        }

        const name = getCell(row, ["姓名", "會員姓名", "name"]);
        const phone = getCell(row, ["電話(唯一鍵)", "電話", "手機", "手机号", "phone"]).trim();
        const balanceRaw = getCell(row, ["餘額(HKD)", "餘額", "余额", "balance"]).replace(/,/g, "");
        const tierRaw = getCell(row, ["當前折扣檔位(如7.5折，可空)", "當前折扣檔位", "折扣檔位"]);
        const email = getCell(row, ["電郵", "邮箱", "email"]);
        const gender = getCell(row, ["性別", "性别", "gender"]);
        const birthday = getCell(row, ["生日(YYYY-MM-DD)", "生日", "birthday"]);
        const cardNo = getCell(row, ["卡號", "卡号", "card_no"]);
        const wechat = getCell(row, ["微信/WhatsApp", "微信", "whatsapp", "wechat_or_whatsapp"]);
        const registerDate = getCell(row, ["註冊日期(YYYY-MM-DD)", "註冊日期", "注册日期", "register_date"]);
        const statusRaw = getCell(row, ["狀態(啟用/停用)", "狀態", "状态", "active"]);
        const notes = getCell(row, ["備註", "备注", "notes"]);

        if (name === "示例會員_請刪除" || notes.includes("示例行")) {
          continue;
        }

        if (!name || !phone || !balanceRaw) {
          throw new Error(`第 ${rowNo} 行：姓名、電話、餘額是必填`);
        }
        const balance = Number(balanceRaw);
        if (!Number.isFinite(balance) || balance < 0) {
          throw new Error(`第 ${rowNo} 行：餘額格式錯誤`);
        }

        const parsedManualRate = parseManualTierRate(tierRaw, rowNo);
        const existing = memberByPhone.get(phone);
        if (existing) {
          const ok = window.confirm(`第 ${rowNo} 行：電話 ${phone} 已存在「${existing.name}」，是否覆蓋？`);
          if (!ok) {
            skipped += 1;
            continue;
          }
          const payload: Member = {
            ...existing,
            name,
            phone,
            email: email || existing.email || "",
            balance,
            manual_locked_discount_rate:
              parsedManualRate !== undefined ? parsedManualRate : existing.manual_locked_discount_rate,
            gender: gender || existing.gender || "",
            birthday: birthday || existing.birthday || "",
            card_no: cardNo || existing.card_no || "",
            wechat_or_whatsapp: wechat || existing.wechat_or_whatsapp || "",
            register_date: registerDate || existing.register_date || today,
            active: parseActiveValue(statusRaw, existing.active),
            updated_at: now,
            notes: notes || existing.notes || "",
          };
          await upsertMemberLocal(payload);
          memberByPhone.set(phone, payload);
          updated += 1;
          continue;
        }

        const payload: Member = {
          member_id: crypto.randomUUID(),
          name,
          phone,
          email: email || "",
          balance,
          manual_locked_discount_rate: parsedManualRate,
          active: parseActiveValue(statusRaw, true),
          gender: gender || "",
          birthday: birthday || "",
          card_no: cardNo || "",
          wechat_or_whatsapp: wechat || "",
          register_date: registerDate || today,
          created_at: now,
          updated_at: now,
          notes: notes || "",
        };
        await upsertMemberLocal(payload);
        memberByPhone.set(phone, payload);
        created += 1;
      }

      setMessage(`會員導入完成：新增 ${created}，覆蓋 ${updated}，跳過 ${skipped}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "會員導入失敗，請重試");
    } finally {
      setImportingMember(false);
    }
  }

  async function exportStoreExcel() {
    setExportingStore(true);
    setMessage("");
    try {
      await exportStoreLedgerWorkbook(storeRange);
      setMessage("已導出店鋪流水 Excel");
    } catch {
      setMessage("店鋪流水 Excel 導出失敗，請重試");
    } finally {
      setExportingStore(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">郵件同步配置</h2>
        <p className="mt-2 text-sm text-slate-600">
          每日首次聯網，會自動寄出兩份全量 Excel（會員資料、店鋪流水）。
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <input
            value={smtpSettings.host}
            onChange={(event) => setSmtpSettings((prev) => ({ ...prev, host: event.target.value }))}
            placeholder="SMTP 伺服器"
            className="h-11 rounded-xl border border-slate-300 px-3 text-base"
          />
          <div className="flex gap-2">
            <input
              type="number"
              min={1}
              value={smtpSettings.port}
              onChange={(event) =>
                setSmtpSettings((prev) => ({ ...prev, port: Number(event.target.value || 465) }))
              }
              placeholder="連接埠"
              className="h-11 min-w-0 flex-1 rounded-xl border border-slate-300 px-3 text-base"
            />
            <label className="flex items-center gap-2 rounded-xl border border-slate-300 px-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={smtpSettings.secure}
                onChange={(event) =>
                  setSmtpSettings((prev) => ({ ...prev, secure: event.target.checked }))
                }
              />
              SSL
            </label>
          </div>
          <input
            value={smtpSettings.user}
            onChange={(event) => setSmtpSettings((prev) => ({ ...prev, user: event.target.value }))}
            placeholder="SMTP 帳號"
            className="h-11 rounded-xl border border-slate-300 px-3 text-base"
          />
          <input
            type="password"
            value={smtpSettings.pass}
            onChange={(event) => setSmtpSettings((prev) => ({ ...prev, pass: event.target.value }))}
            placeholder="SMTP 密碼"
            className="h-11 rounded-xl border border-slate-300 px-3 text-base"
          />
          <input
            value={smtpSettings.from}
            onChange={(event) => setSmtpSettings((prev) => ({ ...prev, from: event.target.value }))}
            placeholder="發件人郵箱"
            className="h-11 rounded-xl border border-slate-300 px-3 text-base"
          />
          <input
            value={smtpSettings.to}
            onChange={(event) => setSmtpSettings((prev) => ({ ...prev, to: event.target.value }))}
            placeholder="收件人郵箱（多個可用逗號）"
            className="h-11 rounded-xl border border-slate-300 px-3 text-base"
          />
        </div>
        <button
          type="button"
          onClick={saveSmtpConfig}
          className="mt-3 h-11 w-full rounded-xl bg-slate-700 font-semibold text-white"
        >
          保存郵件配置
        </button>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">數據同步</h2>
        <p className="mt-2 text-sm text-slate-600">
          系統會在每日首次聯網時自動同步並發送全量 Excel，若失敗會每30分鐘自動重試。
        </p>
        <button
          type="button"
          onClick={manualSync}
          disabled={syncing}
          className="mt-3 h-11 w-full rounded-xl bg-emerald-600 font-semibold text-white disabled:opacity-60"
        >
          {syncing ? "同步中..." : "立即同步"}
        </button>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">首次使用（建議流程）</h2>
        <p className="mt-2 text-sm text-slate-600">
          初次上線不用先導入舊流水。先導入會員的「當前餘額 + 當前折扣檔位」，就可以直接開單。
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-700">
          <li>先下載會員導入模板</li>
          <li>填姓名、電話、餘額（必填）</li>
          <li>高折扣會員填「當前折扣檔位」，例如 7.5折</li>
          <li>回到本頁批量導入，同電話會逐條詢問是否覆蓋</li>
        </ol>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="text-base font-bold text-slate-900">會員資料導出</h3>
        <p className="mt-2 text-sm text-slate-600">
          導出會員總覽 + 每位會員獨立流水 + 導入模板。批量導入時可填「當前折扣檔位（7.5折）」。
        </p>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <button
            type="button"
            onClick={exportMemberExcel}
            disabled={exportingMember}
            className="h-11 rounded-xl bg-slate-800 font-semibold text-white disabled:opacity-60"
          >
            {exportingMember ? "正在導出..." : "導出會員總覽與流水 Excel"}
          </button>
          <button
            type="button"
            onClick={downloadMemberTemplate}
            disabled={downloadingTemplate}
            className="h-11 rounded-xl bg-slate-700 font-semibold text-white disabled:opacity-60"
          >
            {downloadingTemplate ? "下載中..." : "下載會員導入模板"}
          </button>
          <button
            type="button"
            onClick={() => memberImportInputRef.current?.click()}
            disabled={importingMember}
            className="h-11 rounded-xl bg-cyan-700 font-semibold text-white disabled:opacity-60"
          >
            {importingMember ? "正在導入..." : "批量導入會員 Excel"}
          </button>
        </div>
        <input
          ref={memberImportInputRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (!file) {
              return;
            }
            void importMemberExcel(file);
          }}
        />
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="text-base font-bold text-slate-900">店鋪流水導出</h3>
        <p className="mt-2 text-sm text-slate-600">按時間範圍導出：總覽 + 消費明細 + 每日彙總。</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {RANGE_OPTIONS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setStoreRange(item.value)}
              className={`rounded-xl px-3 py-2 text-sm font-semibold ${
                storeRange === item.value ? "bg-cyan-700 text-white" : "bg-slate-100 text-slate-700"
              }`}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            onClick={exportStoreExcel}
            disabled={exportingStore}
            className="rounded-xl bg-cyan-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {exportingStore ? "導出中..." : "導出"}
          </button>
        </div>
      </section>

      {message && <p className="text-sm font-semibold text-slate-700">{message}</p>}
    </div>
  );
}
