"use client";

import type { AnalysisRange } from "@/lib/analytics";
import { runDailyBackup } from "@/lib/backup-client";
import {
  getDefaultBackupMailSettings,
  loadBackupMailSettings,
  saveBackupMailSettings,
  type BackupMailSettings,
} from "@/lib/backup-settings";
import { exportMemberLedgerWorkbook } from "@/lib/member-ledger-export";
import { exportStoreLedgerWorkbook } from "@/lib/store-ledger-export";
import { useEffect, useState } from "react";

const RANGE_OPTIONS: Array<{ value: AnalysisRange; label: string }> = [
  { value: "WEEK", label: "本周" },
  { value: "30D", label: "最近30天" },
  { value: "QUARTER", label: "最近一季度" },
  { value: "365D", label: "最近365天" },
  { value: "ALL", label: "所有" },
];

export default function SyncPanel() {
  const [message, setMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [exportingMember, setExportingMember] = useState(false);
  const [exportingStore, setExportingStore] = useState(false);
  const [storeRange, setStoreRange] = useState<AnalysisRange>("30D");
  const [smtpSettings, setSmtpSettings] = useState<BackupMailSettings>(getDefaultBackupMailSettings);

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
        <h3 className="text-base font-bold text-slate-900">會員資料導出</h3>
        <p className="mt-2 text-sm text-slate-600">導出會員總覽 + 每位會員獨立流水 + 導入模板。</p>
        <button
          type="button"
          onClick={exportMemberExcel}
          disabled={exportingMember}
          className="mt-3 h-11 w-full rounded-xl bg-slate-800 font-semibold text-white disabled:opacity-60"
        >
          {exportingMember ? "正在導出..." : "導出會員總覽與流水 Excel"}
        </button>
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
