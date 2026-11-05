/**
 * LLM 판단 계층 — 공급자와 무관한 부분(프롬프트·응답 정리·규칙 검증). 직접 구현.
 *
 * 역할 나눔
 *  - LLM(선택 기능, 유료 API): 한국어 문장을 "수어 단어(기본형) 순서 후보"로 바꾼다. 동작·영상을 만들지 않는다.
 *  - 이 파일(규칙): 후보를 기존 사전·동작 목록으로 검사한다.
 *      1 없는 단어 금지: 국립국어원 사전에도 동작 목록에도 없는 말은 버린다(지문자 표시한 고유명사만 허용)
 *      2 근거 검사: 입력 문장이나 규칙 분석 결과에서 찾을 수 없는 말을 덧붙이면 기록하고 확인을 요청한다
 *      3 누락 검사: 규칙 분석이 찾은 동작 있는 단어를 LLM이 조금 빼면 되살리고, 절반 넘게 빼면 후보를 버린다
 *      4 뜻 검사: LLM이 준 뜻 힌트가 사전 분류와 맞을 때만 그 뜻을 쓰고, 동작의 뜻과 다르면 재생하지 않는다
 *      5 어순: 시간 앞·의문사 뒤·부정 동사 뒤 규칙을 다시 적용한다(같은 그룹 안에서는 LLM 순서 유지)
 *    검사에서 크게 어긋나면 LLM 후보를 버리고 규칙 결과(planner.ts)를 그대로 쓴다.
 *  - 키가 없거나, 시간 초과·오류가 나면 화면은 규칙 분석만 쓴다(SignTranslator.tsx).
 *
 * 공급자별 호출 코드는 서버 전용 파일 llmProviders.ts에 있다. 이 파일은 브라우저·서버·테스트 어디서나 쓴다.
 */
import { findMotion, isWhWord, numberGloss, orderTokens, predicateStems, resolveToken, strip, SYNONYMS, type Lexicon, type PlanToken, type SignPlan } from "./planner.ts";

/** LLM이 돌려줘야 하는 형식(정리 후) */
export interface LlmCandidate {
  glosses: { word: string; sense?: string; fingerspell?: boolean }[];
  question: "yesno" | "wh" | null;
  negation: boolean;
  note: string;
}

export interface LlmVerification {
  /** 화면에 쓸 최종 계획. accepted=false면 규칙 계획 그대로(llmNotes만 덧붙임) */
  plan: SignPlan;
  accepted: boolean;
  notes: string[];
}

export const LLM_LIMITS = { maxWords: 20, maxWordLength: 20, maxNoteLength: 200 } as const;

/**
 * 시스템 프롬프트. allowed는 동작이 있는 수어 단어 목록(public/motions/aihub_gloss/index.json의 키).
 * 목록 밖의 말도 쓸 수 있게 하되(사전에 있으면 '동작 없음'으로 표시) 검사기가 다시 거른다.
 */
export function buildSystemPrompt(allowed: string[]): string {
  return [
    "너는 한국어 문장을 한국수어(KSL) 단어 순서 후보로 바꾸는 보조 도구다. 번역의 정확성을 보장하지 않으며, 결과는 규칙·사전으로 다시 검사된다.",
    "규칙:",
    "1. 각 단어는 사전 기본형으로 쓴다(명사, 용언은 '-다' 형). 조사·어미·높임 보조용언('주세요')은 뺀다.",
    "2. 가능한 한 아래 '동작 있는 단어' 목록 안의 말로만 쓴다. 같거나 비슷한 뜻의 목록 단어가 있으면 반드시 그 말로 바꾼다(예: 요금→돈, 정류장·역→곳, 돕다→도와주다, 오다→오다오다, 1호선→1호).",
    "3. 목록으로 바꿀 수 없는 말만 국립국어원 한국수어사전의 표준 기본형으로 쓴다. 문장 뜻에 꼭 필요하지 않은 말은 빼도 된다. 입력에 없는 내용을 지어내지 않는다.",
    "4. 사람·장소 이름처럼 지문자가 필요한 고유명사는 fingerspell: true로 표시한다.",
    "5. 어순: 시간 표현은 앞, 의문사(무엇·어디·언제·누구·왜·얼마·몇·방법)는 끝, 부정은 동사 뒤.",
    "6. 뜻이 여러 개인 단어(예: 배)에만 sense에 분류 한 단어를 적는다(예: 교통, 신체, 과일). 다른 단어에는 sense를 쓰지 않는다.",
    "7. 같은 단어가 문장에 여러 번 나오면 나온 만큼 따로 쓰고 각각 sense를 적는다. 한 단어를 겹쳐 쓰지 않는다(오다오다 ✗).",
    "8. 음성 인식 오류·오타·띄어쓰기 오류(예: 택씨→택시, 학교를간다→학교 가다)는 문맥에 맞게 고쳐서 쓴다.",
    '출력은 JSON 하나만: {"glosses":[{"word":"택시","sense":"교통"}],"question":"wh"|"yesno"|null,"negation":false,"note":"짧은 설명"}',
    `동작 있는 단어: ${allowed.join(", ")}`,
  ].join("\n");
}

/** LLM 응답 문자열에서 JSON을 꺼내 형식·길이를 제한한다. 쓸 수 없으면 null */
export function parseCandidate(raw: unknown): LlmCandidate | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const m = raw.match(/\{[\s\S]*\}/); // 코드 블록·앞뒤 설명이 섞여도 첫 JSON 객체만
    if (!m) return null;
    try { obj = JSON.parse(m[0]); } catch { return null; }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.glosses)) return null;
  const glosses: LlmCandidate["glosses"] = [];
  for (const g of o.glosses.slice(0, LLM_LIMITS.maxWords)) {
    const item = typeof g === "string" ? { word: g } : g && typeof g === "object" ? g as Record<string, unknown> : null;
    const word = typeof item?.word === "string" ? strip(item.word).slice(0, LLM_LIMITS.maxWordLength) : "";
    if (!word || !/^[가-힣0-9]+$/.test(word)) continue;
    glosses.push({
      word,
      ...(typeof item?.sense === "string" && item.sense.trim() ? { sense: item.sense.trim().slice(0, 20) } : {}),
      ...(item?.fingerspell === true ? { fingerspell: true } : {}),
    });
  }
  return {
    glosses,
    question: o.question === "wh" || o.question === "yesno" ? o.question : null,
    negation: o.negation === true,
    note: typeof o.note === "string" ? o.note.slice(0, LLM_LIMITS.maxNoteLength) : "",
  };
}

const NEG_WORDS = new Set(["아니다", "안되다", "않다", "없다", "못하다"]);
const PRONOUN_SOURCES: Record<string, RegExp> = { "나": /(저|제|내|나)/, "무엇": /(뭐|무엇|뭘|무슨)/ };

/** 입력 문장이나 규칙 분석에서 그 단어의 근거를 찾을 수 있는가 */
function grounded(word: string, input: string, rule: SignPlan): boolean {
  const flat = input.replace(/\s+/g, "");
  // AI-Hub 표기처럼 겹친 말(오다오다)은 앞 절반으로 근거를 찾는다
  const half = word.length % 2 === 0 ? word.slice(0, word.length / 2) : "";
  if (half && half + half === word && half !== word && grounded(half, input, rule)) return true;
  const stem = word.endsWith("다") && word.length >= 2 ? word.slice(0, -1) : word;
  // 용언 활용형(오다→와·왔, 걷다→걸어)이 입력에 있으면 근거로 본다(규칙 분석과 같은 계산)
  if (word.endsWith("다") && predicateStems(word).some((s) => flat.includes(s))) return true;
  if (rule.tokens.some((t) => t.lemma === word) || rule.corrections.some((c) => c.to === word)) return true;
  if (flat.includes(stem) || (stem.length >= 3 && flat.includes(stem.slice(0, 2)))) return true;
  // 활용으로 첫 글자 받침이 바뀌는 용언(타다→탔, 가다→갔)은 첫 글자 초성·중성이 같으면 근거로 본다
  if (stem.length === 1 && [...flat].some((ch) => sameOnset(ch, stem))) return true;
  return PRONOUN_SOURCES[word]?.test(flat) ?? false;
}

function sameOnset(a: string, b: string) {
  const code = (c: string) => c.charCodeAt(0) - 0xac00;
  const x = code(a), y = code(b);
  return x >= 0 && y >= 0 && x < 11172 && y < 11172 && Math.floor(x / 28) === Math.floor(y / 28);
}

/** LLM이 준 뜻 힌트(교통·신체…)를 사전 분류와 맞춰 본다. 맞으면 그 뜻으로 토큰을 고친다 */
function applySenseHint(t: PlanToken, hint: string, lex: Lexicon): string | null {
  const entries = lex.senses.get(t.lemma);
  if (!entries || entries.length < 2) return null;
  const hit = entries.find((e) => e.c.includes(hint));
  if (!hit) return `'${t.lemma}' 뜻 힌트 '${hint}'가 사전 분류와 맞지 않아 규칙 선택을 유지`;
  if (t.sense?.id === hit.id) return null;
  const prev = t.sense;
  t.sense = { id: hit.id, category: hit.c, handshape: hit.h, reason: `LLM 뜻 제안(사전 분류 '${hint}' 일치)` };
  t.alternatives = entries.filter((e) => e.id !== hit.id).map((e) => ({ id: e.id, category: e.c }));
  // 동작의 뜻이 바뀐 뜻과 다르면 재생하지 않는다(규칙 분석과 같은 원칙)
  const borrowed = !lex.motions.has(strip(t.lemma));
  const motion = borrowed ? t.motion : findMotion(t.lemma, lex)?.find((m) => !m.senseId || m.senseId === hit.id);
  if (motion) { t.motion = motion; t.status = "playable"; t.note = undefined; }
  else if (t.status === "playable") {
    t.status = "no_motion";
    t.motion = undefined;
    t.note = `보유 동작은 다른 뜻이라 재생하지 않음`;
  }
  return `'${t.lemma}' 뜻을 ${prev?.category.split(" > ").at(-1) ?? "미정"} → ${hit.c.split(" > ").at(-1)}(으)로 바꿈(LLM 제안, 사전 확인)`;
}

/**
 * LLM 후보를 규칙·사전으로 검사해 최종 계획을 정한다.
 * rule은 같은 입력의 규칙 분석 결과(planSentence). 후보를 버릴 때 그대로 돌려준다.
 */
export function verifyCandidate(input: string, cand: LlmCandidate | null, lex: Lexicon, rule: SignPlan): LlmVerification {
  const reject = (why: string, notes: string[] = []): LlmVerification => {
    const all = [...notes, `LLM 후보를 쓰지 않음: ${why}. 규칙 분석 결과를 사용`];
    return { plan: { ...rule, llmNotes: all }, accepted: false, notes: all };
  };
  if (!cand) return reject("응답 형식 오류");
  if (!cand.glosses.length) return reject("빈 후보");

  const notes: string[] = [];
  // 같은 단어가 떨어져서 여러 번 나오는 것은 살린다("배가 고파서 배를 타기 전에 배를 먹었다" = 신체·선박·과일).
  // 바로 이어서 같은 말을 반복하거나 "오다오다"처럼 겹쳐 쓴 것만 하나로 정리한다(실측에서 나온 LLM 실수)
  const words: LlmCandidate["glosses"] = [];
  for (const g of cand.glosses) {
    const half = g.word.length % 2 === 0 ? g.word.slice(0, g.word.length / 2) : "";
    // 단, 동작 목록에 겹친 모양 그대로 있는 말은 진짜 수어 단어다(AI-Hub 표기 '오다오다' 등)
    const word = half && half + half === g.word && !lex.motions.has(g.word) && (lex.senses.has(half) || lex.motions.has(half)) ? half : g.word;
    if (word !== g.word) notes.push(`겹쳐 쓴 말 정리: ${g.word} → ${word}`);
    if (words.at(-1)?.word === word && words.at(-1)?.sense === g.sense) continue;
    // 숫자 표기도 규칙과 같게(1호선 → 1호)
    words.push({ ...g, word: /^\d/.test(word) ? numberGloss(word, lex) : word });
  }
  // 1 없는 단어 금지
  const known = (w: string) => lex.motions.has(w) || lex.senses.has(w) || !!findMotion(w, lex) || /^\d/.test(w);
  const invented = words.filter((g) => !known(g.word) && !g.fingerspell).map((g) => g.word);
  if (invented.length) notes.push(`사전·동작 목록에 없는 말 버림: ${invented.join(", ")}`);
  const kept = words.filter((g) => !invented.includes(g.word));
  if (!kept.length || invented.length * 2 >= words.length) return reject("사전에 없는 말이 너무 많음", notes);

  // 2 근거 검사(입력에 없는 말 덧붙이기)
  const ungrounded = kept.filter((g) => !NEG_WORDS.has(g.word) && !isWhWord(g.word) && !grounded(g.word, input, rule)).map((g) => g.word);
  if (ungrounded.length) notes.push(`입력에서 근거를 찾지 못한 말: ${ungrounded.join(", ")}`);
  if (ungrounded.length * 3 > kept.length) return reject("입력에 없는 말을 너무 많이 덧붙임", notes);

  // 부정은 규칙과 같은 방식(동사 뒤 부정 수어 하나)으로 통일한다
  const negation = cand.negation || rule.negation || kept.some((g) => g.word === "않다");
  const content = kept.filter((g, i) => !(negation && (g.word === "아니다" || g.word === "않다"))
    // "충전하세요"를 충전·하다로 쪼갠 경우: 명사 바로 뒤의 하다·되다는 말씨일 뿐이라 뺀다(11/5 실측)
    && !((g.word === "하다" || g.word === "되다") && i > 0 && lex.nouns.has(kept[i - 1].word)));
  const lemmas = content.map((g) => g.word);
  let ambiguous = 0;
  const tokens = content.map((g) => {
    const kind: PlanToken["kind"] = /^\d/.test(g.word) ? "number" : g.word.endsWith("다") && g.word.length >= 2 && lex.predLemmas.has(g.word) ? "pred" : "noun";
    const r = known(g.word)
      ? resolveToken(g.word, { lemma: g.word, kind }, lemmas.filter((l) => l !== g.word), lex)
      : resolveToken(g.word, null, [], lex);
    if (g.fingerspell && r.token.status === "unknown") r.token.note = "고유명사(지문자 필요, LLM 표시)";
    if (g.sense) {
      const n = applySenseHint(r.token, g.sense, lex);
      if (n) notes.push(n);
      else if (r.ambiguous) ambiguous++;
    } else if (r.ambiguous) ambiguous++;
    // 동작이 없는 말은 AI-Hub 문장에서 같은 뜻으로 쓰인 동작 단어로 바꾼다(규칙 분석의 유의어 표와 같음: 역→곳 등)
    const syn = r.token.status !== "playable" ? SYNONYMS[r.token.lemma] : undefined;
    if (syn && findMotion(syn, lex)) {
      notes.push(`유의어로 바꿈: ${r.token.lemma} → ${syn}(동작 있는 말)`);
      return resolveToken(g.word, { lemma: syn, kind }, lemmas.filter((l) => l !== g.word), lex).token;
    }
    return r.token;
  });

  // 3 누락 검사: 규칙이 찾은 동작 있는 단어를 빼먹었는가
  const llmSet = new Set(tokens.map((t) => t.lemma));
  const rulePlayable = rule.tokens.filter((t) => t.status === "playable").map((t) => t.lemma);
  const dropped = rulePlayable.filter((l) => !llmSet.has(l));
  if (dropped.length * 2 > rulePlayable.length && rulePlayable.length >= 2) {
    notes.push(`규칙 분석에는 있는데 LLM이 뺀 말: ${dropped.join(", ")}`);
    return reject("규칙이 찾은 단어를 절반 넘게 뺌", notes);
  }
  // 조금 뺀 경우에는 규칙 결과에서 되살린다. 같은 문장도 실행마다 LLM 답이 달라 '얼마'처럼 핵심어가 빠진 적이 있음(11/5 실측)
  for (const lemma of dropped) {
    const restored = rule.tokens.find((t) => t.lemma === lemma && t.status === "playable");
    // 규칙 결과에서의 자리 앞에 있던 단어 바로 뒤에 넣는다(안녕하세요가 맨 뒤로 가지 않게)
    if (!restored) continue;
    const before = rule.tokens.slice(0, rule.tokens.indexOf(restored)).map((t) => t.lemma);
    const at = tokens.reduce((pos, t, i) => (before.includes(t.lemma) ? i + 1 : pos), 0);
    tokens.splice(at, 0, restored);
  }
  if (dropped.length) notes.push(`LLM이 빠뜨린 말을 규칙 결과에서 되살림: ${dropped.join(", ")}`);

  // 5 어순 규칙 재적용
  const order = orderTokens(tokens, negation, lex);
  const question = tokens.some((t) => isWhWord(t.lemma)) ? "wh" : cand.question === "yesno" || rule.question === "yesno" ? "yesno" : null;
  const unknown = tokens.filter((t) => t.status === "unknown" && !t.note?.includes("LLM 표시")).length;
  const reasons = [...rule.reasons.filter((r) => r.startsWith("의문문"))];
  if (ungrounded.length || dropped.length || invented.length) reasons.push("LLM 후보 일부가 규칙 검사와 맞지 않음");
  if (unknown) reasons.push(`사전에 없는 말 ${unknown}개`);
  if (ambiguous) reasons.push(`뜻이 여러 개인데 문맥 단서가 없는 말 ${ambiguous}개`);
  const confidence = unknown || !tokens.length ? "low" : ungrounded.length || dropped.length || invented.length || ambiguous ? "medium" : "high";
  if (cand.note) notes.push(`LLM 설명: ${cand.note}`);
  return {
    plan: {
      input, tokens, order, question, negation, corrections: rule.corrections, confidence,
      needsConfirm: confidence !== "high", reasons, source: "llm", llmNotes: notes,
    },
    accepted: true,
    notes,
  };
}
