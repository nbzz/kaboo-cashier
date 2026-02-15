# Kaboo Cashier

![version](https://img.shields.io/badge/version-0.1.0-0ea5e9)
![license](https://img.shields.io/badge/license-AGPL--3.0-green)
![Next.js](https://img.shields.io/badge/Next.js-16-black)
![PWA](https://img.shields.io/badge/PWA-supported-14b8a6)

理髮 / 美容店用的 PWA 會員記賬系統（離線優先，單設備版）。

## 在線地址

- [https://kaboo.ittz.top](https://kaboo.ittz.top)

## 核心功能

- 快速記賬：會員搜尋、項目多選、折扣計算、餘額扣減
- 會員管理：新增 / 編輯、充值、會員流水
- 流水查詢：篩選與可視化分析
- 價目表管理：中英欄位、分類維護、Excel 導入導出
- 數據同步：郵件備份（Excel）
- PWA：可加入 iPad / 手機主畫面

## 本地啟動

```bash
npm install
npm run dev
```

打開 [http://localhost:3000](http://localhost:3000)

## 環境變量

建立 `.env.local`：

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USER=your-email@example.com
SMTP_PASS=your-smtp-password
BACKUP_FROM_EMAIL=your-email@example.com
BACKUP_TO_EMAIL=backup@example.com
```

## 部署

推薦部署到 Vercel。

## 授權

本專案採用雙授權：

1. 開源授權：`AGPL-3.0-or-later`（見 `/LICENSE`）
2. 商業授權：閉源商用、二次售賣、SaaS 商業化請聯絡作者購買商業授權（見 `/LICENSE-COMMERCIAL.md`）
