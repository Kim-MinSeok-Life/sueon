/**
 * LLM 공급자 연결 지점(서버 전용). 키는 .env.local의 환경변수로만 받고, 브라우저로 보내지 않는다.
 *
 * 고르는 순서(SUEON_LLM_PROVIDER)
 *  - "anthropic": ANTHROPIC_API_KEY 필요. 공식 SDK(@anthropic-ai/sdk) 사용
 *  - "openai":    OPENAI_API_KEY 필요. Chat Completions를 fetch로 호출(기존 /api/analyze 방식 유지)
 *  - "gemini":    GEMINI_API_KEY 필요(Google AI Studio 무료 등급 가능). Gemini의 OpenAI 호환 주소로 같은 방식 호출
 *  - "mock":      개발 전용 가짜 응답(키·비용 없음). 화면 흐름 확인용이며 번역 결과가 아니다
 *  - 비우면: ANTHROPIC_API_KEY → OPENAI_API_KEY → GEMINI_API_KEY 순으로 있는 쪽, 없으면 null(규칙 분석만)
 *
 * 2026-11-05: 무료 등급을 위해 gemini 추가. 실제 응답은 키를 넣은 뒤 첫 호출로 검증해야 한다.
 */
import Anthropic from "@anthropic-ai/sdk";

const GEMINI_OPENAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

export interface LlmProvider {
  id: "anthropic" | "openai" | "gemini" | "mock";
  model: string;
  /** 시스템 프롬프트 + 사용자 문장 → 모델이 돌려준 원문 텍스트(JSON 기대) */
  complete(system: string, user: string, signal: AbortSignal): Promise<string>;
}

export function getLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider | null {
  const choice = (env.SUEON_LLM_PROVIDER ?? "").trim().toLowerCase();
  if (choice === "mock") return env.NODE_ENV === "production" ? null : mockProvider;
  if (choice === "anthropic" || (!choice && env.ANTHROPIC_API_KEY)) {
    return env.ANTHROPIC_API_KEY ? anthropicProvider(env.ANTHROPIC_API_KEY, env.SUEON_LLM_MODEL || "claude-opus-5-5") : null;
  }
  if (choice === "openai" || (!choice && env.OPENAI_API_KEY)) {
    return env.OPENAI_API_KEY ? openaiProvider(env.OPENAI_API_KEY, env.SUEON_LLM_MODEL || "gpt-4o-mini") : null;
  }
  if (choice === "gemini" || (!choice && env.GEMINI_API_KEY)) {
    return env.GEMINI_API_KEY
      // 짧은 변환 작업이라 생각 단계를 줄인다(기본값이면 20초를 넘겨 시간 초과가 났음)
      ? openaiProvider(env.GEMINI_API_KEY, env.SUEON_LLM_MODEL || "gemini-3.5-flash-lite", "gemini", GEMINI_OPENAI_URL,
        { reasoning_effort: env.SUEON_LLM_REASONING || "low" })
      : null;
  }
  return null;
}

function anthropicProvider(apiKey: string, model: string): LlmProvider {
  const client = new Anthropic({ apiKey, maxRetries: 1 });
  return {
    id: "anthropic", model,
    async complete(system, user, signal) {
      // 짧은 변환 작업이라 effort low. 안전 분류기가 거절하면 서버 측 대체 모델로 다시 시도(fallbacks: "default")
      const res = await client.beta.messages.create({
        model, max_tokens: 2000, system,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: user }],
      }, { signal });
      if (res.stop_reason === "refusal") throw new Error("LLM이 요청을 거절함");
      return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    },
  };
}

/** OpenAI Chat Completions 형식(OpenAI 본가, Gemini 호환 주소 공용) */
function openaiProvider(apiKey: string, model: string, id: "openai" | "gemini" = "openai",
  url = "https://api.openai.com/v1/chat/completions", extra: Record<string, unknown> = {}): LlmProvider {
  const call = (body: object, signal: AbortSignal) => fetch(url, {
    method: "POST", signal, cache: "no-store",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    id, model,
    async complete(system, user, signal) {
      const base = { model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
      let res = await call({ ...base, ...extra, response_format: { type: "json_object" } }, signal);
      // JSON 모드나 추가 옵션을 지원하지 않는 호환 주소면 400 → 기본 요청으로 한 번 더(응답 정리는 parseCandidate가 함)
      if (res.status === 400) res = await call(base, signal);
      if (!res.ok) {
        // 원인 파악용으로 상태와 응답 앞부분만 서버 로그에 남긴다(키는 남기지 않음)
        const detail = (await res.text()).slice(0, 300);
        console.error(`[llm:${id}] 요청 실패 ${res.status}: ${detail}`);
        throw new Error(`${id} 요청 실패(${res.status}): ${detail}`);
      }
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? "";
    },
  };
}

/** 개발용 가짜 공급자: 정해 둔 문장에만 후보를 돌려준다(그 외는 빈 후보 → 규칙 분석으로 돌아감) */
const MOCK_ANSWERS: Record<string, object> = {
  "택시 기본요금 얼마예요?": { glosses: [{ word: "택시" }, { word: "기본" }, { word: "돈" }, { word: "얼마" }], question: "wh", note: "요금→돈(동작 목록 단어)" },
  "배를 탔어요": { glosses: [{ word: "배", sense: "교통" }, { word: "타다" }], question: null, note: "타다와 함께 쓰여 선박" },
  "다음 역에서 내려요": { glosses: [{ word: "다음" }, { word: "곳" }, { word: "내리다", sense: "교통" }], question: null, note: "역→곳" },
};
const mockProvider: LlmProvider = {
  id: "mock", model: "mock",
  async complete(_system, user) {
    return JSON.stringify(MOCK_ANSWERS[user.trim()] ?? { glosses: [], question: null, note: "mock: 준비된 문장 아님" });
  },
};
