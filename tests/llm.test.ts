import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLexicon, planSentence, type DictEntry } from "../src/lib/ksl/planner.ts";
import { buildSystemPrompt, parseCandidate, ruleIsConfident, verifyCandidate } from "../src/lib/ksl/llm.ts";
import { getLlmProvider } from "../src/lib/ksl/llmProviders.ts";

// LLM 응답을 흉내 낸 후보로 검증 규칙만 시험한다(실제 API 호출 없음).
const dictionary: DictEntry[] = [
  { id: 7847, w: [["배", "신체의"]], c: "인간 > 신체 부위 및 내부 구성", d: true, h: "", j: null },
  { id: 7845, w: [["배", "과일"]], c: "식생활 > 과일", d: true, h: "", j: null },
  { id: 7846, w: [["배"], ["선박"]], c: "사회생활 > 교통", d: true, h: "", j: null },
  { id: 1, w: [["먹다"]], c: "식생활", d: true, h: "", j: null },
  { id: 2, w: [["아프다"]], c: "인간 > 신체", d: true, h: "", j: null },
  { id: 3, w: [["나"]], c: "인간", d: true, h: "", j: null },
  { id: 4, w: [["요금"]], c: "경제생활", d: true, h: "", j: null },
  { id: 5, w: [["역"]], c: "사회생활 > 교통", d: true, h: "", j: null },
  { id: 6, w: [["오다"]], c: "기타", d: true, h: "", j: null },
  { id: 7, w: [["고프다"]], c: "인간 > 신체", d: true, h: "", j: null },
];
const glossItems = {
  "택시": { path: "/m/taxi.json" }, "기본": { path: "/m/base.json" }, "돈": { path: "/m/money.json" },
  "얼마": { path: "/m/howmuch.json" }, "타다": { path: "/m/ride.json" }, "가다": { path: "/m/go.json" },
  "밤": { path: "/m/night.json" }, "아니다": { path: "/m/no.json" },
  "배": { path: "/m/ship.json", context: ["타다", "가다"] },
  "곳": { path: "/m/place.json" }, "내리다": { path: "/m/off.json" }, "다음": { path: "/m/next.json" },
};
const lex = buildLexicon({ glossItems, dictionary });
const verify = (text: string, raw: unknown) => verifyCandidate(text, parseCandidate(raw), lex, planSentence(text, lex));

test("응답 정리: 코드 블록·설명이 섞여도 JSON만 꺼내고, 형식이 틀리면 null", () => {
  const c = parseCandidate('여기 결과입니다\n```json\n{"glosses":[{"word":"택시"},"돈",{"word":"<script>"}],"question":"wh"}\n```');
  assert.deepEqual(c?.glosses.map((g) => g.word), ["택시", "돈"]);
  assert.equal(c?.question, "wh");
  assert.equal(parseCandidate("모르겠어요"), null);
  assert.equal(parseCandidate('{"ids":[]}'), null);
});

test("프롬프트에 동작 있는 단어 목록과 JSON 형식을 넣는다", () => {
  const p = buildSystemPrompt(["택시", "돈"]);
  assert.match(p, /동작 있는 단어: 택시, 돈/);
  assert.match(p, /"glosses"/);
});

test("검증 통과: 사전·동작에 있는 말이고 입력에 근거가 있으면 LLM 후보를 쓴다", () => {
  const r = verify("택시 기본요금 얼마예요?", { glosses: [{ word: "택시" }, { word: "기본" }, { word: "돈" }, { word: "얼마" }], question: "wh" });
  assert.equal(r.accepted, true);
  assert.equal(r.plan.source, "llm");
  assert.deepEqual(r.plan.order.map((t) => t.lemma), ["택시", "기본", "돈", "얼마"]);
  assert.equal(r.plan.question, "wh");
});

test("없는 단어 금지: 사전에 없는 말은 버리고, 많으면 후보 전체를 버린다", () => {
  const some = verify("택시 타요", { glosses: [{ word: "택시" }, { word: "타다" }, { word: "뿅뿅" }] });
  assert.equal(some.accepted, true);
  assert.ok(!some.plan.order.some((t) => t.lemma === "뿅뿅"));
  assert.ok(some.notes.some((n) => n.includes("뿅뿅")));
  const most = verify("택시 타요", { glosses: [{ word: "뿅뿅" }, { word: "쾅쾅" }, { word: "택시" }] });
  assert.equal(most.accepted, false);
  assert.equal(most.plan.source, "rules");
});

test("근거 검사: 입력에 없는 말을 덧붙이면 기록하고, 많으면 버린다", () => {
  const r = verify("택시 타요", { glosses: [{ word: "택시" }, { word: "타다" }, { word: "밤" }, { word: "돈" }] });
  assert.equal(r.accepted, false);
  assert.ok(r.plan.llmNotes?.some((n) => n.includes("근거")));
});

test("뜻 검사: LLM 뜻 힌트가 사전 분류와 맞으면 따르고, 동작의 뜻과 다르면 재생하지 않는다", () => {
  const ship = verify("배를 탔어요", { glosses: [{ word: "배", sense: "교통" }, { word: "타다" }] });
  assert.equal(ship.plan.order[0].status, "playable");
  assert.equal(ship.plan.order[0].sense?.id, 7846);
  // 배(신체)로 고르면 선박 동작은 재생하지 않는다
  const belly = verify("배가 아파요", { glosses: [{ word: "배", sense: "신체" }, { word: "아프다" }] });
  assert.equal(belly.plan.order[0].sense?.id, 7847);
  assert.equal(belly.plan.order[0].status, "no_motion");
  // 사전에 없는 분류 힌트는 무시하고 규칙 선택 유지
  const odd = verify("배를 탔어요", { glosses: [{ word: "배", sense: "우주" }, { word: "타다" }] });
  assert.equal(odd.plan.order[0].sense?.id, 7846);
  assert.ok(odd.notes.some((n) => n.includes("맞지 않아")));
});

test("어순 규칙 재적용: 의문사는 끝, 시간은 앞, 부정은 동사 뒤", () => {
  const r = verify("밤에 택시 안 타요", { glosses: [{ word: "택시" }, { word: "밤" }, { word: "타다" }, { word: "아니다" }], negation: true });
  assert.deepEqual(r.plan.order.map((t) => t.lemma), ["밤", "택시", "타다", "아니다"]);
  const q = verify("얼마 택시", { glosses: [{ word: "얼마" }, { word: "택시" }] });
  assert.deepEqual(q.plan.order.map((t) => t.lemma), ["택시", "얼마"]);
});

test("누락 검사: 규칙이 찾은 동작 단어를 절반 넘게 빼면 규칙 결과를 쓴다", () => {
  const r = verify("택시 기본요금 얼마예요?", { glosses: [{ word: "얼마" }] });
  assert.equal(r.accepted, false);
  assert.equal(r.plan.source, "rules");
  assert.equal(verify("택시", null).accepted, false);
});

test("실측 보완(11/5): 떨어진 반복 단어는 각자 뜻 유지, 겹쳐 쓴 말 정리, 동작 없는 말은 유의어로", () => {
  // 같은 '배'가 세 번: LLM이 준 뜻을 각각 따라야 한다(예전엔 중복 제거로 하나만 남았음)
  const three = verify("배가 고파서 배를 타기 전에 배를 먹었어요", { glosses: [
    { word: "배", sense: "신체" }, { word: "고프다" }, { word: "배", sense: "교통" }, { word: "타다" }, { word: "배", sense: "과일" }, { word: "먹다" }] });
  assert.deepEqual(three.plan.tokens.filter((t) => t.lemma === "배").map((t) => t.sense?.id), [7847, 7846, 7845]);
  // "오다오다" → "오다"
  const doubled = verify("버스 언제 와요?", { glosses: [{ word: "택시" }, { word: "오다오다" }] });
  assert.ok(doubled.plan.tokens.some((t) => t.lemma === "오다"));
  assert.ok(doubled.notes.some((n) => n.includes("겹쳐 쓴 말 정리")));
  // 동작 목록에 겹친 모양 그대로 있으면(AI-Hub 표기 '오다오다') 바꾸지 않는다
  const lexDup = buildLexicon({ glossItems: { ...glossItems, "오다오다": { path: "/m/come.json" } }, dictionary });
  const kept = verifyCandidate("택시 언제 와요?", parseCandidate({ glosses: [{ word: "택시" }, { word: "오다오다" }] }), lexDup, planSentence("택시 언제 와요?", lexDup));
  assert.equal(kept.accepted, true); // '와요'가 '오다오다'의 근거로 인정됨(활용형 와)
  assert.ok(kept.plan.tokens.some((t) => t.lemma === "오다오다" && t.status === "playable"));
  // 동작 없는 '역' → 동작 있는 '곳'
  const station = verify("다음 역에서 내려요", { glosses: [{ word: "다음" }, { word: "역" }, { word: "내리다" }] });
  assert.ok(station.plan.order.some((t) => t.lemma === "곳" && t.status === "playable"));
  // LLM이 핵심어(얼마)를 빠뜨리면 규칙 결과에서 되살리고, 의문사라 맨 뒤로
  const missing = verify("택시 기본요금 얼마예요?", { glosses: [{ word: "택시" }, { word: "기본" }, { word: "돈" }] });
  assert.equal(missing.accepted, true);
  assert.deepEqual(missing.plan.order.map((t) => t.lemma), ["택시", "기본", "돈", "얼마"]);
  assert.equal(missing.plan.question, "wh");
  // 되살린 말은 원래 자리로(맨 앞 단어가 빠졌으면 맨 앞에)
  const front = verify("택시 기본요금 얼마예요?", { glosses: [{ word: "기본" }, { word: "돈" }, { word: "얼마" }] });
  assert.deepEqual(front.plan.order.map((t) => t.lemma), ["택시", "기본", "돈", "얼마"]);
  // 명사 바로 뒤 '하다'는 뺀다
  const hada = verify("택시 타요", { glosses: [{ word: "택시" }, { word: "하다" }, { word: "타다" }] });
  assert.ok(!hada.plan.order.some((t) => t.lemma === "하다"));
});

test("공급자 선택: 키가 없으면 null(규칙 분석), mock은 개발에서만", () => {
  assert.equal(getLlmProvider({ NODE_ENV: "development" } as NodeJS.ProcessEnv), null);
  assert.equal(getLlmProvider({ NODE_ENV: "development", SUEON_LLM_PROVIDER: "anthropic" } as NodeJS.ProcessEnv), null);
  assert.equal(getLlmProvider({ NODE_ENV: "development", SUEON_LLM_PROVIDER: "mock" } as NodeJS.ProcessEnv)?.id, "mock");
  assert.equal(getLlmProvider({ NODE_ENV: "production", SUEON_LLM_PROVIDER: "mock" } as NodeJS.ProcessEnv), null);
  assert.equal(getLlmProvider({ NODE_ENV: "development", OPENAI_API_KEY: "x" } as NodeJS.ProcessEnv)?.id, "openai");
  assert.equal(getLlmProvider({ NODE_ENV: "development", ANTHROPIC_API_KEY: "x" } as NodeJS.ProcessEnv)?.model, "claude-opus-5-5");
  // 무료 등급용 Gemini: 키만 있으면 자동 선택, 모델은 SUEON_LLM_MODEL로 바꿀 수 있음
  assert.equal(getLlmProvider({ NODE_ENV: "development", GEMINI_API_KEY: "x" } as NodeJS.ProcessEnv)?.id, "gemini");
  assert.equal(getLlmProvider({ NODE_ENV: "development", SUEON_LLM_PROVIDER: "gemini" } as NodeJS.ProcessEnv), null);
  assert.equal(getLlmProvider({ NODE_ENV: "development", SUEON_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "x", SUEON_LLM_MODEL: "gemini-2.5-flash-lite" } as NodeJS.ProcessEnv)?.model, "gemini-2.5-flash-lite");
});

test("규칙이 확실하면 LLM 생략: 모든 단어에 동작이 있고 확신도 high일 때만", () => {
  assert.equal(ruleIsConfident(planSentence("택시 타고 가요", lex)), true);
  // 동작 없는 말(먹다)·모르는 말·뜻이 애매한 말이 섞이면 LLM을 불러 본다
  assert.equal(ruleIsConfident(planSentence("밥을 먹다", lex)), false);
  assert.equal(ruleIsConfident(planSentence("학교를간다", lex)), false);
  // 뜻이 여러 개인 말(배)이 두 번 나오면 규칙만 믿지 않는다
  assert.equal(ruleIsConfident(planSentence("배를 타고 배를 타요", lex)), false);
});

test("부정은 하나만: LLM이 못하다를 따로 줘도 동사 뒤 부정 수어 하나", () => {
  const r = verify("배를 못 타요", { glosses: [{ word: "배", sense: "교통" }, { word: "타다" }, { word: "못하다" }], negation: true });
  const lemmas = r.plan.order.map((t) => t.lemma);
  assert.equal(lemmas.filter((l) => l === "못하다" || l === "아니다").length, 1);
});

// 사용자 요청(2026-11-06): 오인식·어순을 바로잡은 문장을 화면에 다시 써 준다
test("LLM 교정 문장(text)과 말 순서가 뒤바뀐 문장", () => {
  const c = parseCandidate('{"text":"급하시면 9호선으로 갈아타세요","glosses":[{"word":"급하다"},{"word":"9호"},{"word":"갈아타다"}],"question":null,"negation":false,"note":""}');
  assert.equal(c?.text, "급하시면 9호선으로 갈아타세요");
  assert.equal(parseCandidate('{"text":"<script>","glosses":[{"word":"가다"}]}')?.text, undefined);
  const l = buildLexicon({ glossItems: { "급하다": { path: "/m/a.json" }, "9호": { path: "/m/b.json" }, "갈아타다": { path: "/m/c.json" } } });
  const input = "갈아타세요 9호선으로 급하시면";
  const rule = planSentence(input, l);
  assert.equal(ruleIsConfident(rule, input), false);
  assert.equal(verifyCandidate(input, c, l, rule).plan.correctedText, "급하시면 9호선으로 갈아타세요");
  assert.equal(ruleIsConfident(planSentence("급하시면 9호선으로 갈아타세요", l), "급하시면 9호선으로 갈아타세요"), true);
});
