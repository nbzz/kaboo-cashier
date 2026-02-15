import { NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { z } from "zod";

export const runtime = "nodejs";

const backupSchema = z.object({
  device_id: z.string().min(8),
  backup_date: z.string().min(10),
  smtp: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    secure: z.boolean().optional(),
    user: z.string().min(1),
    pass: z.string().min(1),
    from: z.string().email(),
    to: z.string().min(1),
  }),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        content_type: z.string().min(1),
        content_base64: z.string().min(1),
      }),
    )
    .min(1),
});

function parseRecipients(raw: string) {
  const list = raw
    .split(/[,;\n，；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(list));
}

export async function POST(request: Request) {
  try {
    const parsed = backupSchema.parse(await request.json());
    const recipients = parseRecipients(parsed.smtp.to);
    if (recipients.length === 0) {
      throw new Error("收件人不可為空");
    }

    const transporter = nodemailer.createTransport({
      host: parsed.smtp.host,
      port: parsed.smtp.port,
      secure: parsed.smtp.secure ?? parsed.smtp.port === 465,
      auth: {
        user: parsed.smtp.user,
        pass: parsed.smtp.pass,
      },
    });

    await transporter.sendMail({
      from: parsed.smtp.from,
      to: recipients.join(","),
      subject: `會員與店鋪流水備份 ${parsed.backup_date}`,
      text: `自動備份已完成\n日期: ${parsed.backup_date}\n設備: ${parsed.device_id}\n附件: 會員資料 + 店鋪流水`,
      attachments: parsed.attachments.map((file) => ({
        filename: file.filename,
        content: Buffer.from(file.content_base64, "base64"),
        contentType: file.content_type,
      })),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "backup-email-failed",
      },
      { status: 400 },
    );
  }
}
