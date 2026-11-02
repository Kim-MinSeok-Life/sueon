import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production" && process.env.SUEON_ENABLE_PAID_API_PUBLIC !== "true") {
    return NextResponse.json({ error: "공개 배포 환경에서 유료 AI API를 비활성화했습니다. 서버 설정과 비용 제한을 확인해 주세요." }, { status: 503 });
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "서버 음성 인식 API 키가 설정되지 않았습니다. 브라우저 음성 인식이나 텍스트 입력을 이용해 주세요." }, { status: 503 });
  }
  try {
    const input = await request.formData();
    const audio = input.get("file");
    if (!(audio instanceof File) || !audio.size || audio.size > 25 * 1024 * 1024) {
      return NextResponse.json({ error: "음성 파일을 확인해 주세요(최대 25MB)." }, { status: 400 });
    }
    const body = new FormData();
    body.set("file", audio, audio.name || "speech.webm");
    body.set("model", "gpt-transcribe");
    const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body,
      signal: AbortSignal.timeout(30000), cache: "no-store",
    });
    if (!upstream.ok) {
      return NextResponse.json({ error: "외부 음성 인식 서비스에 연결하지 못했습니다." }, { status: 502 });
    }
    const result = (await upstream.json()) as { text?: unknown };
    if (typeof result.text !== "string") throw new Error("음성 인식 응답에 텍스트가 없습니다.");
    return NextResponse.json({ text: result.text.slice(0, 200) });
  } catch {
    return NextResponse.json({ error: "음성 처리 과정에서 오류가 발생했습니다." }, { status: 500 });
  }
}
