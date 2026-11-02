import type { Metadata, Viewport } from "next";
import PwaRegister from "@/components/PwaRegister";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "SUEO:N | 수어온",
  description: "수어온 (SUEO:N) : AI 기반 수어 소통 서비스 · 한국어 음성·텍스트를 수어 아바타로 연결하는 소통 서비스",
  applicationName: "SUEO:N",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "SUEO:N", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f766e" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ko"><body><PwaRegister />{children}</body></html>;
}
