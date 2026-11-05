/**
 * 한국어 문장 → 한국수어(KSL) 표현 계획 (규칙 기반, 직접 구현 · AI 학습 모델 아님).
 *
 * 처리 순서
 *  1. 말버릇 정리: "어/음" 같은 군말, 같은 말 반복, 더듬은 조각("택 택시", "택택시") 제거
 *  2. 형태 분석: 조사 떼기(택시를→택시), 용언 활용 복원(탔어요→타다), "운전해요"→운전,
 *     복합명사 나누기(기본요금→기본+요금), 부탁 보조용언 빼기("내려 주세요"의 '주세요')
 *  3. 오타 교정: 사전에 없는 말은 자모 편집 거리로 가장 가까운 사전 단어 제안("택씨"→택시)
 *  4. 의미 고르기: 국립국어원 한국수어사전에서 의미가 여러 개인 단어(배: 신체/과일/선박/배수)는
 *     괄호 문맥 단서와 함께 쓰인 말(먹다·타다·아프다)로 고른다
 *  5. 동작 연결: 실제 촬영 문장에서 잘라 낸 gloss 동작 → 단어 촬영 동작 순. 동작에도 원래 문장의 문맥으로
 *     뜻을 정해 두고, 입력 문장의 뜻과 다르면 재생하지 않는다(배를 탔다 ↛ 배(신체) 동작)
 *  6. 수어 어순: 시간 표현은 앞으로, 의문사(얼마·어디…)는 뒤로, "안 ~"은 동사 뒤 부정으로
 *  7. 자신 없으면(오타 교정·모르는 말·의미 애매) needsConfirm=true. 화면은 동작 있는 단어를 먼저 재생하고 확인 안내를 함께 보여 준다
 *
 * 한계: 수어 문법(공간 지시, 일치동사, 분류사, 표정)을 모두 처리하지 않는다. 한국어 정답 문장이 없어
 * 정확도 점수를 아직 측정하지 못했다. 결과를 정확한 한국수어 번역이라고 표시하지 않는다.
 */
import { addJong, dropJong, jamoDistance, jongOf, jungOf, setJung } from "./hangul.ts";

export interface DictEntry { id: number; w: string[][]; c: string; d: boolean; h: string; j: string | null }
export interface MotionRef {
  gloss: string;
  path: string;
  source: "sentence-gloss" | "word";
  duration?: number;
  /** 원래 촬영 문장의 문맥으로 정한 수어사전 의미 번호(동음이의어 판별용) */
  senseId?: number;
  senseCategory?: string;
}
export interface Lexicon {
  motions: Map<string, MotionRef[]>;
  senses: Map<string, DictEntry[]>;
  nouns: Set<string>;
  predStems: Map<string, string>;
  predLemmas: Set<string>;
}

export type TokenStatus = "playable" | "no_motion" | "unknown";
export interface PlanToken {
  surface: string;
  lemma: string;
  kind: "noun" | "pred" | "number" | "unknown";
  status: TokenStatus;
  motion?: MotionRef;
  sense?: { id: number; category: string; handshape: string; reason: string };
  alternatives?: { id: number; category: string }[];
  note?: string;
}
export interface Correction { from: string; to: string; reason: "filler" | "repeat" | "stutter" | "typo" | "aux" | "synonym" }
export interface SignPlan {
  input: string;
  tokens: PlanToken[];
  order: PlanToken[];
  question: "yesno" | "wh" | null;
  negation: boolean;
  corrections: Correction[];
  confidence: "high" | "medium" | "low";
  needsConfirm: boolean;
  reasons: string[];
  /** 누가 만든 계획인가: 규칙 분석기 / LLM 후보를 규칙·사전으로 검증한 것(llm.ts) */
  source: "rules" | "llm";
  /** LLM 후보를 쓰지 않았거나 고친 이유(검증 기록) */
  llmNotes?: string[];
}

export const strip = (w: string) => w.replace(/\s+/g, "").replace(/\d+$/, "");

// ---------------------------------------------------------------- 용언 활용
/** "타다" → {타, 탔, 탄, 탈, 탑} 처럼 활용형의 앞부분(어간 변이형)을 만든다. */
export function predicateStems(lemma: string): string[] {
  if (!lemma.endsWith("다") || lemma.length < 2) return [];
  const S = lemma.slice(0, -1);
  const out = new Set<string>([S]);
  const last = S.at(-1)!;
  const v = jungOf(last);
  const jong = jongOf(last);
  const bright = ["ㅏ", "ㅗ", "ㅑ"].includes(v);
  const forms: (string | null)[] = [];
  if (S.endsWith("하")) forms.push(S.slice(0, -1) + "해", S + "여");
  else if (!jong) {
    const map: Record<string, string> = { "ㅗ": "ㅘ", "ㅜ": "ㅝ", "ㅣ": "ㅕ", "ㅚ": "ㅙ" };
    if (["ㅏ", "ㅓ", "ㅐ", "ㅔ", "ㅕ", "ㅑ"].includes(v)) forms.push(S);
    else if (map[v]) forms.push(setJung(S, map[v]), S + (v === "ㅚ" ? "어" : ""));
    else if (v === "ㅡ") {
      const prev = S.length > 1 ? jungOf(S.at(-2)!) : "";
      forms.push(setJung(S, ["ㅏ", "ㅗ"].includes(prev) ? "ㅏ" : "ㅓ"));
      if (S.endsWith("르") && S.length > 1) { // 르 불규칙: 모르다 → 몰라
        const head = addJong(S.slice(0, -1), "ㄹ");
        if (head) forms.push(head + (["ㅏ", "ㅗ"].includes(prev) ? "라" : "러"));
      }
    } else forms.push(S + "어");
    for (const j of ["ㄴ", "ㄹ", "ㅂ"]) forms.push(addJong(S, j));
  } else {
    forms.push(S + (bright ? "아" : "어"));
    if (jong === "ㅂ") { const d = dropJong(S); if (d) forms.push(d + "워", d + "우"); }
    if (jong === "ㄷ") { const d = dropJong(S); const l = d && addJong(d, "ㄹ"); if (l) forms.push(l + (bright ? "아" : "어"), l); }
    if (jong === "ㅅ") { const d = dropJong(S); if (d) forms.push(d + (bright ? "아" : "어")); }
    if (jong === "ㄹ") { const d = dropJong(S); if (d) { forms.push(d); for (const j of ["ㄴ", "ㅂ"]) forms.push(addJong(d, j)); } }
  }
  for (const f of forms) {
    if (!f) continue;
    out.add(f);
    const past = addJong(f, "ㅆ");
    if (past) out.add(past);
  }
  return [...out];
}

const PARTICLES = new Set(["", "이", "가", "은", "는", "을", "를", "에", "에서", "서", "에선", "에게", "한테", "께", "께서", "도", "만",
  "의", "로", "으로", "와", "과", "랑", "이랑", "하고", "까지", "부터", "처럼", "보다", "요", "이요", "이에요", "예요", "에요", "입니다",
  "이다", "야", "이야", "이나", "나", "라도", "이라도", "마다", "밖에", "에는", "에서는", "으로는", "로는", "에도", "는요", "은요",
  "이지", "지", "인데", "이고", "인가요", "인가", "일까요", "이죠", "죠", "니까", "이니까", "이면", "면", "에서요", "으로요", "로요",
  // 겹조사: '에·에서·으로' 뒤 강조 보조사 '를'("시장에를 갔니"), '에다(가)', '에게서·한테서', 조사+보조사
  "에를", "에서를", "로를", "으로를", "에다", "에다가", "에게서", "한테서", "께서는", "에서도", "까지는", "부터는", "만을", "만은",
  "으로도", "로도", "와는", "과는", "하고는", "이랑은", "랑은"]);
const COMMON_PARTICLE = new Set(["이", "가", "을", "를", "은", "는", "도", "의", "에"]);
const ENDING_HEAD = /^(다|요|고|서|니|는|은|을|면|으|지|죠|네|나|까|세|시|습|ㅂ|어|아|야|도|게|기|던|든|자|려|러|며|냐|래|군|구|ㄴ|ㄹ)/;
const NOUN_VERB = /^(하|해|했|합|한|할|함|하세|되|돼|됐|된|될|됩|나|났|난|날)/;
// 요청·보조 표현: 수어 단어가 아니라 높임·부탁의 말씨(표정·자세로 표현)
const AUX = new Set(["주세요", "줘요", "줘", "주십시오", "주실래요", "주시겠어요", "주실", "주시면", "줄래요", "주세용", "있어요", "있습니까"]);
// AI-Hub 교통 문장에서 같은 뜻을 나타낸 수어 단어(동작이 있는 쪽)로 바꾼다
export const SYNONYMS: Record<string, string> = { "돕다": "도와주다", "요금": "돈", "운임": "돈", "역": "곳", "정류장": "곳", "정거장": "곳", "이후": "후", "뒤": "후", "어떻게": "방법" };

function isEnding(rest: string) {
  return rest === "" || (rest.length <= 6 && ENDING_HEAD.test(rest));
}

// ---------------------------------------------------------------- 사전 구성
export function buildLexicon(input: {
  glossItems: Record<string, { path: string; duration?: number; context?: string[] }>;
  words?: { korean: string; motion_path: string | null }[];
  dictionary?: DictEntry[];
}): Lexicon {
  const senses = new Map<string, DictEntry[]>();
  for (const e of input.dictionary ?? []) for (const [w] of e.w) {
    const k = strip(w);
    if (k) senses.set(k, [...(senses.get(k) ?? []), e]);
  }
  const lex: Lexicon = { motions: new Map(), senses, nouns: new Set(), predStems: new Map(), predLemmas: new Set() };
  const add = (g: string, ref: MotionRef, context: string[] = []) => {
    const k = strip(g);
    if (!k) return;
    const s = chooseSense(k, context, lex, ref.source === "sentence-gloss" ? /교통/ : undefined);
    // 단서도 영역 기본값도 없으면 뜻을 정하지 않는다(재생을 막지 않음)
    if (s.sense && (s.cued || s.domain)) { ref.senseId = s.sense.id; ref.senseCategory = s.sense.category; }
    lex.motions.set(k, [...(lex.motions.get(k) ?? []), ref]);
  };
  for (const [g, it] of Object.entries(input.glossItems)) {
    add(g, { gloss: g, path: it.path, source: "sentence-gloss", duration: it.duration }, (it.context ?? []).map(strip));
  }
  for (const w of input.words ?? []) if (w.motion_path && !w.korean.startsWith("#")) add(w.korean, { gloss: w.korean, path: w.motion_path, source: "word" });
  for (const w of new Set([...lex.motions.keys(), ...senses.keys()])) {
    if (w.endsWith("다") && w.length >= 2) {
      lex.predLemmas.add(w);
      for (const s of predicateStems(w)) if (!lex.predStems.has(s) || lex.motions.has(w)) lex.predStems.set(s, w);
    } else lex.nouns.add(w);
  }
  return lex;
}

// ---------------------------------------------------------------- 1. 말버릇 정리
const FILLERS = new Set(["어", "음", "엄", "어어", "음음", "으음", "에", "에에", "아아", "흠", "막", "좀", "이제", "그니까", "그러니까", "뭐지", "저기요"]);
const SOFT_FILLERS = new Set(["그", "저", "뭐"]); // 같은 말이 이어질 때만 군말로 본다

export function normalizeTokens(text: string, corrections: Correction[]): { tokens: string[]; questionMark: boolean } {
  const questionMark = /[?？]/.test(text);
  const raw = text.replace(/[.,!?？~…·"'“”‘’()\[\]{}:;]/g, " ").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (FILLERS.has(t)) { corrections.push({ from: t, to: "", reason: "filler" }); continue; }
    const softRun = raw[i + 1] === t || raw[i - 1] === t || SOFT_FILLERS.has(raw[i + 1] ?? "") || (raw[i + 1] ?? "").startsWith(t);
    if (SOFT_FILLERS.has(t) && softRun) { corrections.push({ from: t, to: "", reason: "filler" }); continue; }
    if (out.at(-1) === t) { corrections.push({ from: t, to: "", reason: "repeat" }); continue; }
    out.push(t);
  }
  return { tokens: out, questionMark };
}

// ---------------------------------------------------------------- 2·3. 형태 분석 + 오타 교정
interface Parsed { lemma: string; kind: PlanToken["kind"]; rest: string }

function parseExact(tok: string, lex: Lexicon): Parsed | null {
  const num = tok.match(/^(\d+(?:시간|시|분|호선|호|회|사람|원|번|살|개|명|층|월|일)?)(.*)$/);
  if (num && PARTICLES.has(num[2])) return { lemma: num[1], kind: "number", rest: num[2] };
  // "배가 아파요": 사전에 '배가(倍加)'도 있지만 흔한 쓰임은 '배+가'. 짧은 명사+주요 조사 우선(긴 쪽에 동작이 있으면 예외)
  const last = tok.at(-1) ?? "";
  if (tok.length >= 2 && COMMON_PARTICLE.has(last) && lex.nouns.has(tok.slice(0, -1)) && !lex.motions.has(tok)) {
    return { lemma: tok.slice(0, -1), kind: "noun", rest: last };
  }
  let noun: Parsed | null = null;
  let pred: Parsed | null = null;
  for (let n = tok.length; n >= 1 && !noun; n--) {
    const p = tok.slice(0, n);
    const rest = tok.slice(n);
    if (lex.nouns.has(p) && (PARTICLES.has(rest) || NOUN_VERB.test(rest))) noun = { lemma: p, kind: "noun", rest };
  }
  for (let n = tok.length; n >= 1 && !pred; n--) {
    const p = tok.slice(0, n);
    const rest = tok.slice(n);
    const lemma = lex.predStems.get(p);
    if (lemma && isEnding(rest)) pred = { lemma, kind: "pred", rest };
  }
  if (noun && pred) {
    // "전하기·위해": '전(앞)+하기', '위(신체)+해'가 아니라 사전에 있는 용언 '전하다·위하다'. 명사 동작은 findMotion이 뜻이 같을 때만 빌려 씀
    if (NOUN_VERB.test(noun.rest) && pred.lemma.startsWith(noun.lemma) && lex.senses.has(pred.lemma)) return pred;
    // "가요": 명사(노래)와 용언(가다+요) 모두 가능 → 통째 명사 일치가 아니거나 동작이 용언 쪽에만 있으면 용언
    const nm = lex.motions.has(noun.lemma), pm = lex.motions.has(pred.lemma);
    if (pm && !nm) return pred;
    if (nm && !pm) return noun;
    return noun.lemma.length > pred.lemma.length - 1 && noun.rest === "" && pred.rest !== "" ? pred : noun;
  }
  return noun ?? pred;
}

/** 복합명사: "기본요금이" → [기본, 요금] (앞 명사 2음절 이상) */
function parseCompound(tok: string, lex: Lexicon): Parsed[] | null {
  for (let k = tok.length - 1; k >= 2; k--) {
    const head = tok.slice(0, k);
    if (!lex.nouns.has(head)) continue;
    const tail = parseExact(tok.slice(k), lex);
    if (tail && tail.kind === "noun") return [{ lemma: head, kind: "noun", rest: "" }, tail];
  }
  return null;
}

function parseFuzzy(tok: string, lex: Lexicon): Parsed | null {
  // 끝의 조사·어미 후보를 떼어 낸 핵심부를 사전 단어와 자모 거리로 비교
  const cores = new Set([tok]);
  for (let n = tok.length - 1; n >= 1; n--) if (PARTICLES.has(tok.slice(n)) || ENDING_HEAD.test(tok.slice(n))) cores.add(tok.slice(0, n));
  let best: { d: number; lemma: string; kind: "noun" | "pred"; rest: string; motion: boolean } | null = null;
  for (const core of cores) {
    if (core.length < 2) continue;
    const limit = core.length >= 4 ? 2 : 1;
    const rest = tok.slice(core.length);
    const consider = (cand: string, lemma: string, kind: "noun" | "pred") => {
      if (Math.abs(cand.length - core.length) > 1 || !findMotion(lemma, lex)) return;
      const d = jamoDistance(core, cand);
      if (d === 0 || d > limit) return;
      const motion = lex.motions.has(lemma);
      if (!best || d < best.d || (d === best.d && motion && !best.motion)) best = { d, lemma, kind, rest, motion };
    };
    for (const nn of lex.nouns) consider(nn, nn, "noun");
    for (const [stem, lemma] of lex.predStems) consider(stem, lemma, "pred");
  }
  const b = best as { lemma: string; kind: "noun" | "pred"; rest: string } | null;
  return b ? { lemma: b.lemma, kind: b.kind, rest: b.rest } : null;
}

// ---------------------------------------------------------------- 4. 의미 고르기
const CATEGORY_CUES: [RegExp, string[]][] = [
  [/교통/, ["타다", "내리다", "차내리다", "갈아타다", "가다", "오다", "운전", "항구", "바다", "섬", "여행", "출발", "도착", "버스", "지하철", "택시", "기차", "곳", "역"]],
  [/식생활|과일|음식/, ["먹다", "맛있다", "맛없다", "사다", "깎다", "달다", "시다", "과일", "마시다", "요리", "맛", "디저트"]],
  [/신체/, ["아프다", "고프다", "부르다", "다치다", "병원", "약", "통증", "배부르다", "배고프다", "수술", "위쪼이다"]],
  [/개념 > 수/, ["두", "세", "몇", "숫자", "곱하다", "많다"]],
];

export function chooseSense(lemma: string, context: string[], lex: Pick<Lexicon, "senses">, domain?: RegExp):
  Pick<PlanToken, "sense" | "alternatives"> & { ambiguous: boolean; cued: boolean; domain?: boolean } {
  const all = lex.senses.get(lemma);
  if (!all?.length) return { ambiguous: false, cued: false };
  // 일상생활 수어가 있으면 전문용어 수어는 후보에서 뺀다(교과·학술 용어로 잘못 고르는 것 방지)
  const cands = all.some((e) => e.d) ? all.filter((e) => e.d) : all;
  const scored = cands.map((e) => {
    let score = 0;
    const reasons: string[] = [];
    for (const [, ctx] of e.w.filter(([w]) => strip(w) === lemma)) {
      if (!ctx) continue;
      const cue = ctx.replace(/(의|이|가|을|를|은|는)$/, "");
      if (context.some((c) => c === cue || c.startsWith(cue))) { score += 3; reasons.push(`문맥 '${cue}'`); }
    }
    for (const [re, cues] of CATEGORY_CUES) {
      if (!re.test(e.c)) continue;
      const hit = context.find((c) => cues.includes(c));
      if (hit) { score += 2; reasons.push(`'${hit}'와 함께 쓰임`); }
    }
    if (strip(e.w[0][0]) === lemma) score += 0.3;
    // AI-Hub 문장은 교통·길 안내 영역: 단서가 없을 때만 영역 뜻을 약하게 우선
    if (domain?.test(e.c)) score += 1;
    return { e, score, reasons };
  }).sort((a, b) => b.score - a.score);
  const top = scored[0];
  const cued = top.reasons.length > 0;
  return {
    ambiguous: cands.length > 1 && !cued,
    cued,
    domain: !!domain && domain.test(top.e.c),
    sense: { id: top.e.id, category: top.e.c, handshape: top.e.h, reason: top.reasons.join(", ") || (cands.length > 1 ? "문맥 단서 없음" : "단일 의미") },
    alternatives: scored.slice(1).map((s) => ({ id: s.e.id, category: s.e.c })),
  };
}

// ---------------------------------------------------------------- 5. 동작 연결
export function findMotion(lemma: string, lex: Pick<Lexicon, "motions" | "senses">): MotionRef[] | undefined {
  const direct = lex.motions.get(strip(lemma));
  if (direct?.length) return direct;
  // "고장나다·운전하다·추가되다" → 명사 동작(고장·운전·추가)
  const noun = lemma.match(/^(.+?)(나다|하다|되다|시키다)$/)?.[1];
  const m = noun ? lex.motions.get(noun) : undefined;
  if (!m) return undefined;
  // 둘 다 사전에 있는데 큰 분류가 겹치지 않으면 다른 말이다(전하다 '사회생활' ≠ 전 '개념 > 시간')
  const top = (c: string) => c.split(" > ")[0];
  const vs = lex.senses.get(lemma), ns = lex.senses.get(noun!);
  if (vs?.length && ns?.length && !vs.some((v) => ns.some((n) => top(n.c) === top(v.c)))) return undefined;
  return m;
}

// ---------------------------------------------------------------- 6. 어순
const TIME_WORDS = new Set(["오늘", "내일", "어제", "지금", "아침", "점심", "저녁", "밤", "낮", "새벽", "주말", "평일", "이번", "지난", "모레", "요즘"]);
const WH_WORDS = new Set(["무엇", "뭐", "어디", "언제", "누구", "왜", "어떻게", "얼마", "몇", "방법"]);
const PRONOUN: Record<string, string> = { "저": "나", "제": "나", "내": "나", "뭐": "무엇" };
const QUESTION_END = /(까|까요|나요|니|냐|가요|ㄹ까|죠)$/;

export function planSentence(text: string, lex: Lexicon): SignPlan {
  const corrections: Correction[] = [];
  const reasons: string[] = [];
  const { tokens: words, questionMark } = normalizeTokens(text, corrections);
  const parsed: { surface: string; p: Parsed | null; typo: boolean }[] = [];
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    // 더듬은 조각: "택 택시" → 뒤 단어만, "택택시" → "택시"
    if (i + 1 < words.length && words[i + 1].startsWith(w) && w.length < words[i + 1].length && !parseExact(w, lex)) {
      corrections.push({ from: w, to: "", reason: "stutter" });
      continue;
    }
    if (w.length >= 3 && w[0] === w[1] && !parseExact(w, lex) && parseExact(w.slice(1), lex)) {
      corrections.push({ from: w, to: w.slice(1), reason: "stutter" });
      w = w.slice(1);
    }
    // "탈 수 있어요 / 갈 수 없어요": 의존명사 '수'+있다/없다는 수어 '가능/불가능'(국립국어원 사전: 가능 = 할 수 있다)
    const next = words[i + 1] ?? "";
    if (/^수(가|는|도)?$/.test(w) && i > 0 && jongOf(words[i - 1].at(-1)!) === "ㄹ" && /^(있|없)/.test(next)) {
      const lemma = next.startsWith("있") ? "가능" : "불가능";
      corrections.push({ from: `${w} ${next}`, to: lemma, reason: "aux" });
      parsed.push({ surface: `${w} ${next}`, p: { lemma, kind: "pred", rest: "" }, typo: false });
      i++;
      continue;
    }
    // 부탁 보조용언("내려 주세요")은 앞에 용언이 있을 때 뺀다
    if (AUX.has(w) && parsed.at(-1)?.p?.kind === "pred") { corrections.push({ from: w, to: "", reason: "aux" }); continue; }
    const mapped = PRONOUN[w.replace(/(가|는|도)$/, "")];
    if (mapped) { parsed.push({ surface: w, p: { lemma: mapped, kind: "noun", rest: "" }, typo: false }); continue; }
    const exact = parseExact(w, lex);
    if (exact) { parsed.push({ surface: w, p: exact, typo: false }); continue; }
    const compound = parseCompound(w, lex);
    if (compound) { for (const c of compound) parsed.push({ surface: c.lemma, p: c, typo: false }); continue; }
    const fuzzy = parseFuzzy(w, lex);
    if (fuzzy) corrections.push({ from: w, to: fuzzy.lemma, reason: "typo" });
    parsed.push({ surface: w, p: fuzzy, typo: !!fuzzy });
  }
  // 부정: "안 가요" / "가지 않아요" / "못 가요" · "안 돼요"는 수어 '안되다'가 있으면 그것으로
  let negation = false;
  const content: typeof parsed = [];
  for (let i = 0; i < parsed.length; i++) {
    const x = parsed[i];
    if (x.surface === "안" || x.surface === "못") {
      const next = parsed[i + 1];
      if (x.surface === "안" && next?.p?.lemma === "되다" && lex.motions.has("안되다")) {
        content.push({ surface: "안 " + next.surface, p: { lemma: "안되다", kind: "pred", rest: "" }, typo: false });
        i++;
        continue;
      }
      negation = true;
      continue;
    }
    if (x.p?.lemma === "않다" || /^않/.test(x.surface)) { negation = true; continue; }
    content.push(x);
  }
  // 유의어: 동작이 없는 말을 AI-Hub 문장에서 같은 뜻으로 쓴 수어 단어로 바꿈
  for (const x of content) {
    const syn = x.p && SYNONYMS[x.p.lemma];
    if (syn && !findMotion(x.p!.lemma, lex) && findMotion(syn, lex)) {
      corrections.push({ from: x.p!.lemma, to: syn, reason: "synonym" });
      x.p = { ...x.p!, lemma: syn };
    }
  }
  const lemmas = content.map((x) => x.p?.lemma ?? x.surface);
  let ambiguousCount = 0;
  const tokens: PlanToken[] = content.map((x) => {
    const r = resolveToken(x.surface, x.p, lemmas.filter((l) => l !== (x.p?.lemma ?? x.surface)), lex, x.typo);
    if (r.ambiguous) ambiguousCount++;
    return r.token;
  });
  // 단어 하나만 입력하면 단독 촬영(word) 동작을 우선
  if (tokens.length === 1 && tokens[0].status === "playable") {
    const word = findMotion(tokens[0].lemma, lex)?.find((m) => m.source === "word");
    if (word) tokens[0].motion = word;
  }
  const order = orderTokens(tokens, negation, lex);
  const wh = tokens.filter((t) => WH_WORDS.has(t.lemma));
  const lastRest = parsed.at(-1)?.p?.rest ?? parsed.at(-1)?.surface ?? "";
  const question = wh.length ? "wh" : questionMark || QUESTION_END.test(lastRest) ? "yesno" : null;
  if (question === "yesno") reasons.push("의문문: 눈썹 올림 표정은 규칙으로 근사한 것(얼굴 데이터·검수 없음)");

  const typos = corrections.filter((c) => c.reason === "typo").length;
  const unknown = tokens.filter((t) => t.status === "unknown").length;
  if (typos) reasons.push(`오타로 보이는 말 ${typos}개를 사전 단어로 바꿈`);
  if (unknown) reasons.push(`사전에 없는 말 ${unknown}개`);
  if (ambiguousCount) reasons.push(`뜻이 여러 개인데 문맥 단서가 없는 말 ${ambiguousCount}개`);
  const confidence = unknown || !tokens.length ? "low" : typos || ambiguousCount ? "medium" : "high";
  return { input: text, tokens, order, question, negation, corrections, confidence, needsConfirm: confidence !== "high", reasons, source: "rules" };
}

/**
 * 단어 하나(기본형)를 사전·동작과 맞춰 PlanToken으로 만든다. 규칙 분석과 LLM 후보 검증(llm.ts)이 함께 쓴다.
 * context는 같은 문장의 다른 기본형들(의미 고르기 단서), ambiguous는 문맥 단서 없이 뜻이 여러 개인지 여부다.
 */
export function resolveToken(surface: string, p: { lemma: string; kind: PlanToken["kind"] } | null, context: string[], lex: Lexicon, typo = false):
  { token: PlanToken; ambiguous: boolean } {
  if (!p) return { token: { surface, lemma: surface, kind: "unknown", status: "unknown", note: "사전에 없는 말(고유명사면 지문자 필요)" }, ambiguous: false };
  const { lemma, kind } = p;
  const t: PlanToken = { surface, lemma, kind, status: "no_motion" };
  let ambiguous = false;
  const s = chooseSense(lemma, context, lex);
  const motions = findMotion(lemma, lex);
  let motion = motions?.[0];
  if (s.sense) {
    // 의미가 여러 개인 단어: 문맥 단서가 없으면 보유 동작의 의미(교통 문장 영역)를 기본값으로 따른다
    // 단, 단어 하나만 입력해 문맥이 전혀 없으면 기본값을 쓰지 않고 확인을 요청한다("배" 단독)
    const fallback = !s.cued && context.length > 0 && motion?.senseId ? lex.senses.get(lemma)?.find((e) => e.id === motion!.senseId) : undefined;
    t.sense = fallback ? { id: fallback.id, category: fallback.c, handshape: fallback.h, reason: "보유 동작의 의미(문맥 단서 없음)" } : s.sense;
    t.alternatives = s.alternatives?.filter((a) => a.id !== t.sense!.id);
    // 동작은 있는데 그 동작의 뜻이 정해지지 않았다면 어느 뜻이든 같은 동작을 재생하므로 확인하지 않는다
    if (s.ambiguous && !fallback && !(motion && !motion.senseId)) ambiguous = true;
    // 동작이 다른 뜻으로 촬영된 것이면 재생하지 않는다
    // 명사 동작을 빌려 온 용언(운전하다→운전)은 findMotion에서 분류를 이미 맞춰 봤으므로 뜻 번호를 비교하지 않는다
    const borrowed = !lex.motions.has(strip(lemma));
    const same = borrowed ? motion : motions?.find((m) => !m.senseId || m.senseId === t.sense!.id);
    if (motion && !same) t.note = `보유 동작은 다른 뜻(${motion.senseCategory?.split(" > ").at(-1)})이라 재생하지 않음`;
    motion = same;
  }
  if (motion) { t.status = "playable"; t.motion = motion; }
  else if (kind === "number") t.note = "지숫자 동작 필요";
  if (typo) t.note = `오타 교정: ${surface} → ${lemma}`;
  return { token: t, ambiguous };
}

/** 수어 어순: 시간 표현 앞으로, 의문사 뒤로, 부정은 동사 뒤(의문사 앞) */
export function orderTokens(tokens: PlanToken[], negation: boolean, lex: Pick<Lexicon, "motions">): PlanToken[] {
  const time = tokens.filter((t) => isTimeWord(t.lemma));
  const wh = tokens.filter((t) => WH_WORDS.has(t.lemma));
  const order = [...time, ...tokens.filter((t) => !time.includes(t) && !wh.includes(t))];
  if (negation) {
    const neg = lex.motions.get("아니다")?.[0] ?? lex.motions.get("안되다")?.[0];
    order.push({ surface: "(부정)", lemma: neg?.gloss ?? "아니다", kind: "pred", status: neg ? "playable" : "no_motion", motion: neg, note: "부정 표현" });
  }
  return [...order, ...wh];
}

export const isTimeWord = (lemma: string) => TIME_WORDS.has(lemma) || /^\d+(시|분)$/.test(lemma);
export const isWhWord = (lemma: string) => WH_WORDS.has(lemma);

/** 확인 질문·말풍선에 보여 줄 "이렇게 이해했어요" 문장 */
export function describePlan(plan: SignPlan): string {
  return plan.order.map((t) => t.sense && t.alternatives?.length ? `${t.lemma}(${t.sense.category.split(" > ").at(-1)})` : t.lemma).join(" · ")
    + (plan.question === "yesno" ? " ?" : "");
}
