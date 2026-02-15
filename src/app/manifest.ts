import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "會員記賬系統",
    short_name: "會員記賬",
    description: "理髮/美容店 iPad 優先記賬 PWA",
    start_url: "/quick",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#0e7490",
    orientation: "portrait",
    lang: "zh-HK",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
    ],
  };
}
