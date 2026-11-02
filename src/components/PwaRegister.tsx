"use client";
import { useEffect } from "react";

export default function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // 설치 지원은 선택 기능이며 서비스 실행을 중단하지 않는다.
      });
    }
  }, []);
  return null;
}
