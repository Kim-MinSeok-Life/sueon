import type { ExpressionEntry, MatchSegment } from "./types";

/**
 * 규칙 기반 표현 매처 (외부 API 사용 안 함).
 *
 * - 입력을 띄어쓰기 단위로 나누고, 각 어절의 앞부분에서 가장 긴 등록 표현을 찾는다.
 * - 표현 뒤에 남은 부분이 흔한 조사·어미이면 같은 표현으로 본다(예: "화장실은").
 * - 그 외에는 어절 전체를 미지원으로 표시한다. 비슷한 표현으로 대체하지 않는다.
 *
 * 한국어와 한국수어는 어순·문법이 다르므로 이 매처는 "등록 표현 찾기"까지만 담당한다.
 * 문장 단위 번역(어순 재배열, 비수지 표현)은 이 단계의 범위가 아니다.
 */

const TRAILING_PARTICLES = new Set([
  "은", "는", "이", "가", "을", "를", "에", "에서", "도", "요", "의",
  "로", "으로", "와", "과", "좀", "까지", "부터", "만",
]);

const PUNCTUATION = /[.,!?~…·"'“”‘’()\[\]{}:;]/g;

function normalizeWord(word: string): string {
  return word.replace(PUNCTUATION, "").trim();
}

interface Candidate {
  surface: string;
  entry: ExpressionEntry;
}

function buildCandidates(entries: ExpressionEntry[]): Candidate[] {
  const list: Candidate[] = [];
  for (const entry of entries) {
    for (const surface of entry.match) {
      list.push({ surface: normalizeWord(surface), entry });
    }
  }
  // 긴 표현을 먼저 시도해 "안녕하세요"가 "안녕"보다 우선하도록 한다
  return list.sort((a, b) => b.surface.length - a.surface.length);
}

function statusOf(entry: ExpressionEntry): MatchSegment["status"] {
  return entry.supported && entry.motion_path ? "playable" : "no_motion";
}

export function matchSentence(input: string, entries: ExpressionEntry[]): MatchSegment[] {
  const candidates = buildCandidates(entries);
  const words = input.split(/\s+/).map((w) => w.trim()).filter(Boolean);
  const segments: MatchSegment[] = [];

  for (const raw of words) {
    const word = normalizeWord(raw);
    if (!word) continue;

    const hit = candidates.find((c) => {
      if (!word.startsWith(c.surface)) return false;
      const rest = word.slice(c.surface.length);
      return rest === "" || TRAILING_PARTICLES.has(rest);
    });

    if (hit) {
      segments.push({ text: raw, status: statusOf(hit.entry), entry: hit.entry });
    } else {
      segments.push({ text: raw, status: "unsupported", entry: null });
    }
  }

  return segments;
}

/** 재생할 동작 목록 (입력 순서 유지, 동작 데이터가 있는 항목만) */
export function playableEntries(segments: MatchSegment[]): ExpressionEntry[] {
  return segments
    .filter((s) => s.status === "playable" && s.entry)
    .map((s) => s.entry as ExpressionEntry);
}
