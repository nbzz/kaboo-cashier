import type { Metadata } from "next";
import AppProviders from "@/components/app-providers";
import ServiceWorkerRegister from "@/components/sw-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "會員記賬系統",
  description: "理髮/美容店 iPad 優先 PWA 會員記賬系統",
  applicationName: "會員記賬系統",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "會員記賬",
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-HK">
      <body className="antialiased">
        <AppProviders>
          <ServiceWorkerRegister />
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
