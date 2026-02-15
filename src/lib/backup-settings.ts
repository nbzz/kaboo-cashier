"use client";

export interface BackupMailSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

const BACKUP_SETTINGS_KEY = "backup:mail-settings:v1";

const DEFAULT_SETTINGS: BackupMailSettings = {
  host: "smtp.example.com",
  port: 465,
  secure: true,
  user: "",
  pass: "",
  from: "",
  to: "",
};

function normalize(raw: Partial<BackupMailSettings> | null | undefined): BackupMailSettings {
  const portValue = Number(raw?.port ?? DEFAULT_SETTINGS.port);
  return {
    host: String(raw?.host ?? DEFAULT_SETTINGS.host).trim() || DEFAULT_SETTINGS.host,
    port: Number.isFinite(portValue) && portValue > 0 ? portValue : DEFAULT_SETTINGS.port,
    secure: Boolean(raw?.secure ?? DEFAULT_SETTINGS.secure),
    user: String(raw?.user ?? "").trim(),
    pass: String(raw?.pass ?? ""),
    from: String(raw?.from ?? "").trim(),
    to: String(raw?.to ?? "").trim(),
  };
}

export function getDefaultBackupMailSettings() {
  return { ...DEFAULT_SETTINGS };
}

export function loadBackupMailSettings(): BackupMailSettings {
  if (typeof window === "undefined") {
    return getDefaultBackupMailSettings();
  }
  const raw = localStorage.getItem(BACKUP_SETTINGS_KEY);
  if (!raw) {
    return getDefaultBackupMailSettings();
  }
  try {
    return normalize(JSON.parse(raw) as Partial<BackupMailSettings>);
  } catch {
    return getDefaultBackupMailSettings();
  }
}

export function saveBackupMailSettings(input: Partial<BackupMailSettings>) {
  const normalized = normalize(input);
  if (typeof window !== "undefined") {
    localStorage.setItem(BACKUP_SETTINGS_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

export function hasReadyBackupMailSettings(settings: BackupMailSettings) {
  return Boolean(
    settings.host &&
      settings.port > 0 &&
      settings.user &&
      settings.pass &&
      settings.from &&
      parseRecipientList(settings.to).length > 0,
  );
}

export function parseRecipientList(raw: string) {
  const values = raw
    .split(/[,;\n，；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(values));
}
