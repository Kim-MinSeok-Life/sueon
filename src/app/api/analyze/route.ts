import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { buildSystemPrompt, parseCandidate } from "@/lib/ksl/llm";
import { getLlmProvider } from "@/lib/ksl/llmProviders";

export const runtime = "nodejs";

// LLM 판단 계층(선택 기능). 서버는 LLM 후보를 형식만 정리해 돌려주고, 사전·동작 검증은 브라우저(llm.ts verifyCandidate)가 한다.
// 키가 없으면 enabled:false → 화면은 규칙 분석만 쓴다.
const paidBlocked = () => process.env.NODE_ENV === "production" && process.env.SUEON_ENABLE_PAID_API_PUBLIC !== "true";

let allowedCache: string[] | null = null;
async function allowedGlosses(): Promise<string[]> {
  if (allowedCache) return allowedCache;
  try {
    const raw = await readFile(path.join(process.cwd(), "public/motions/aihub_gloss/index.json"), "utf-8");
    allowedCache = Object.keys((JSON.parse(raw) as { items?: Record<string, unknown> }).items ?? {});
  } catch { allowedCache = []; } // 동작 파일이 없는 저장소 사본: 목록 없이 사전 기본형만 요청
  return allowedCache;
}

/** 화면이 처음에 한 번 묻는다: LLM을 쓸 수 있는가(키 값은 절대 보내지 않음) */
export async function GET() {
  const provider = paidBlocked() ? null : getLlmProvider();
  return NextResponse.json({ enabled: !!provider, provider: provider?.id ?? null, model: provider?.model ?? null });
}

export async function POST(request: NextRequest) {
  if (paidBlocked()) {
    return NextResponse.json({ error: "공개 배포 환경에서 유료 AI API를 비활성화했습니다.", fallback: "rules" }, { status: 503 });
  }
  const provider = getLlmProvider();
  if (!provider) return NextResponse.json({ error: "LLM API 키가 없어 규칙 분석만 사용합니다.", fallback: "rules" }, { status: 503 });
  let text: string;
  try {
    const body = (await request.json()) as { text?: unknown };
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 200) throw new Error();
    text = body.text.trim();
  } catch {
    return NextResponse.json({ error: "1~200자의 한국어 입력이 필요합니다." }, { status: 400 });
  }
  try {
    const raw = await provider.complete(buildSystemPrompt(await allowedGlosses()), text, AbortSignal.timeout(20000));
    const candidate = parseCandidate(raw);
    if (!candidate) return NextResponse.json({ error: "LLM 응답 형식 오류", fallback: "rules" }, { status: 502 });
    return NextResponse.json({ candidate, provider: provider.id, model: provider.model,
      disclaimer: "LLM 후보를 규칙·사전으로 검사한 결과이며 한국수어 번역의 정확성을 보장하지 않습니다." });
  } catch {
    return NextResponse.json({ error: "LLM 분석을 완료하지 못했습니다.", fallback: "rules" }, { status: 502 });
  }
}
