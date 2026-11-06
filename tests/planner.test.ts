import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildLexicon, planSentence, predicateStems, describePlan, numberGloss, strip, type DictEntry } from "../src/lib/ksl/planner.ts";
import { jamoDistance } from "../src/lib/ksl/hangul.ts";

// 실제 파일 없이도 돌도록 작은 시험용 사전을 쓴다(국립국어원 '배' 항목 구조를 그대로 본뜸).
const dictionary: DictEntry[] = [
  { id: 7847, w: [["배", "신체의"]], c: "인간 > 신체 부위 및 내부 구성", d: true, h: "오른 손바닥을 배에 댄다.", j: null },
  { id: 7845, w: [["배", "과일"]], c: "식생활 > 과일", d: true, h: "오른 손가락을 구부려 끝을 왼 주먹 등에 두 번 댄다.", j: null },
  { id: 7846, w: [["배"], ["선박"]], c: "사회생활 > 교통", d: true, h: "두 손의 4지 옆면을 맞대어 배 모양을 만들어 밖으로 내민다.", j: null },
  { id: 7848, w: [["배"], ["곱절"]], c: "개념 > 수", d: true, h: "", j: null },
  { id: 1, w: [["먹다"]], c: "식생활", d: true, h: "", j: null },
  { id: 2, w: [["아프다"]], c: "인간 > 신체", d: true, h: "", j: null },
  { id: 3, w: [["나"]], c: "인간", d: true, h: "", j: null },
  { id: 4, w: [["내리다", "비가"]], c: "기타", d: true, h: "", j: null },
  { id: 5, w: [["내리다"], ["하차"]], c: "사회생활 > 교통", d: true, h: "", j: null },
  { id: 6, w: [["비"]], c: "자연", d: true, h: "", j: null },
];
const glossItems = {
  "택시": { path: "/m/taxi.json" }, "기본": { path: "/m/base.json" }, "돈": { path: "/m/money.json" },
  "얼마": { path: "/m/howmuch.json" }, "타다": { path: "/m/ride.json" }, "가다": { path: "/m/go.json" },
  "지하철": { path: "/m/subway.json" }, "밤": { path: "/m/night.json" }, "아니다": { path: "/m/no.json" },
  "운전": { path: "/m/drive.json" }, "천천히": { path: "/m/slow.json" },
};
const lex = buildLexicon({ glossItems, dictionary, words: [{ korean: "골키퍼", motion_path: "/m/gk.json" }] });
const glossOf = (text: string) => planSentence(text, lex).order.map((t) => t.lemma);

test("용언 활용형 복원 규칙", () => {
  assert.ok(predicateStems("타다").includes("탔"));
  assert.ok(predicateStems("가다").includes("갔"));
  assert.ok(predicateStems("먹다").includes("먹었"));
  assert.ok(predicateStems("아프다").includes("아파"));
  assert.ok(predicateStems("오다").includes("왔"));
  assert.ok(predicateStems("내리다").includes("내렸"));
  assert.ok(predicateStems("하다").includes("했"));
  assert.ok(predicateStems("춥다").includes("추워"));
});

test("조사·어미를 떼고 수어 단어로 바꾼다 (조사는 수어로 표현하지 않음)", () => {
  assert.deepEqual(glossOf("택시를 타고 간다"), ["택시", "타다", "가다"]);
  assert.deepEqual(glossOf("운전해요 천천히"), ["운전", "천천히"]);
});

test("동음이의어 '배'를 함께 쓰인 말로 구분한다", () => {
  const sense = (t: string) => planSentence(t, lex).tokens.find((x) => x.lemma === "배")?.sense?.id;
  assert.equal(sense("나는 배를 먹었다"), 7845);
  assert.equal(sense("나는 배를 탔다"), 7846);
  assert.equal(sense("나는 배가 아프다"), 7847);
});

test("괄호 문맥 단서 '(비가)내리다'를 쓴다", () => {
  const t = planSentence("비가 내려요", lex).tokens.find((x) => x.lemma === "내리다");
  assert.equal(t?.sense?.id, 4);
});

test("문맥 단서가 없는 동음이의어는 재생 전에 확인한다", () => {
  const p = planSentence("배", lex);
  assert.equal(p.needsConfirm, true);
  assert.match(p.reasons.join(" "), /뜻이 여러 개/);
});

test("군말·반복·더듬은 조각을 정리한다", () => {
  const p = planSentence("어 그 그 택 택시 택시 기본 돈 얼마예요", lex);
  assert.deepEqual(p.order.map((t) => t.lemma), ["택시", "기본", "돈", "얼마"]);
  assert.ok(p.corrections.some((c) => c.reason === "stutter"));
  assert.ok(p.corrections.some((c) => c.reason === "filler"));
  assert.equal(p.needsConfirm, false);
  assert.deepEqual(glossOf("택택시 타요"), ["택시", "타다"]);
});

test("음성 인식 오타를 사전 단어로 교정하고 확인을 요청한다", () => {
  assert.ok(jamoDistance("택씨", "택시") <= 1);
  const p = planSentence("택씨 타고 지하촐 가요", lex);
  assert.deepEqual(p.order.map((t) => t.lemma), ["택시", "타다", "지하철", "가다"]);
  assert.equal(p.needsConfirm, true);
  assert.ok(p.corrections.filter((c) => c.reason === "typo").length >= 2);
});

test("수어 어순: 시간은 앞으로, 의문사는 뒤로, 부정은 동사 뒤", () => {
  assert.deepEqual(glossOf("택시 얼마예요 밤에"), ["밤", "택시", "얼마"]);
  const neg = planSentence("지하철 안 타요", lex);
  assert.deepEqual(neg.order.map((t) => t.lemma), ["지하철", "타다", "아니다"]);
  assert.equal(neg.negation, true);
  assert.equal(planSentence("택시 타요?", lex).question, "yesno");
  assert.equal(planSentence("택시 얼마예요", lex).question, "wh");
});

test("동작 없는 말·모르는 말은 재생 대상이 아니며 낮은 확신으로 표시", () => {
  const p = planSentence("배 타고 제주도 가요", lex);
  const jeju = p.tokens.find((t) => t.surface.startsWith("제주"));
  assert.equal(jeju?.status, "unknown");
  assert.equal(p.confidence, "low");
  assert.equal(p.tokens.find((t) => t.lemma === "배")?.status, "no_motion");
  assert.match(describePlan(p), /배\(교통\)/);
});

test("단어 하나만 입력하면 단독 촬영 동작을 쓴다", () => {
  const p = planSentence("골키퍼", lex);
  assert.equal(p.tokens[0].motion?.source, "word");
});

// 실제 국립국어원 사전 파일이 있으면 같은 판단이 나오는지 확인(없으면 건너뜀)
const DICT = new URL("../public/ksl/dictionary.json", import.meta.url);
test("실제 국립국어원 사전으로 '배' 구분", { skip: !existsSync(DICT) }, () => {
  const real = JSON.parse(readFileSync(DICT, "utf8")).entries as DictEntry[];
  const rl = buildLexicon({ glossItems, dictionary: real });
  const sense = (t: string) => planSentence(t, rl).tokens.find((x) => x.lemma === "배")?.sense?.id;
  assert.equal(sense("배를 먹었어요"), 7845);
  assert.equal(sense("배를 탔어요"), 7846);
  assert.equal(sense("배가 아파요"), 7847);
});

// ---- 실제 문장 처리 보강 규칙
const lex2 = buildLexicon({
  glossItems: {
    ...glossItems, "곳": { path: "/m/place.json" }, "고장": { path: "/m/broken.json" }, "에어컨": { path: "/m/ac.json" },
    "안되다": { path: "/m/notwork.json" }, "카드": { path: "/m/card.json" }, "내리다": { path: "/m/off.json", context: ["명동"] },
    "여기": { path: "/m/here.json" },
    // 동작 사전의 '배'는 "배 아프다" 문장에서 잘라 낸 신체의 배
    "배": { path: "/m/belly.json", context: ["아프다"] },
  },
  dictionary: [...dictionary, { id: 90, w: [["요금"]], c: "경제", d: true, h: "", j: null }, { id: 91, w: [["되다"]], c: "기타", d: true, h: "", j: null }],
});
const g2 = (text: string) => planSentence(text, lex2).order.map((t) => t.lemma);

test("복합명사 나누기 + 유의어(요금→돈)로 AI-Hub 문장 표현에 맞춘다", () => {
  assert.deepEqual(g2("택시 기본요금 얼마예요?"), ["택시", "기본", "돈", "얼마"]);
});

test("부탁 보조용언('주세요')은 수어 단어로 만들지 않는다", () => {
  const p = planSentence("여기서 내려 주세요", lex2);
  assert.deepEqual(p.order.map((t) => t.lemma), ["여기", "내리다"]);
  assert.ok(p.corrections.some((c) => c.reason === "aux"));
});

test("'안 돼요'는 수어 '안되다', '고장났어요'는 '고장' 동작", () => {
  assert.deepEqual(g2("카드가 안 돼요"), ["카드", "안되다"]);
  assert.deepEqual(g2("에어컨이 고장났어요"), ["에어컨", "고장"]);
});

test("다른 뜻으로 촬영된 동작은 재생하지 않는다 (배를 탔다 ↛ 배(신체) 동작)", () => {
  const ride = planSentence("배를 탔어요", lex2).tokens.find((t) => t.lemma === "배")!;
  assert.equal(ride.sense?.id, 7846);
  assert.equal(ride.status, "no_motion");
  assert.match(ride.note ?? "", /다른 뜻/);
  const belly = planSentence("배가 아파요", lex2).tokens.find((t) => t.lemma === "배")!;
  assert.equal(belly.status, "playable");
});

// 실제 생성된 동작 사전(있을 때만) 검사
const GLOSS = new URL("../public/motions/aihub_gloss/index.json", import.meta.url);
test("수어 단어 동작 사전: 파일 존재·관통 0·문맥 기록", { skip: !existsSync(GLOSS) }, () => {
  const idx = JSON.parse(readFileSync(GLOSS, "utf8"));
  assert.equal(idx.format, "sueon-gloss-library/v1");
  const items = Object.values(idx.items) as { path: string; penetration_after_cm: Record<string, number>; context?: string[] }[];
  assert.ok(items.length >= 300);
  for (const it of items) {
    assert.ok(existsSync(new URL(`../public${it.path}`, import.meta.url)), it.path);
    assert.ok(Math.max(...Object.values(it.penetration_after_cm)) <= 0.2);
    assert.ok(Array.isArray(it.context));
  }
});

// 사용자 피드백(2026-11-01): 하다 용언, 오타 교정 대상, 겹조사
test("실제 사전: '전하기·위해'는 전하다·위하다, '메고'를 엉뚱한 단어로 바꾸지 않음", { skip: !existsSync(DICT) }, () => {
  const real = JSON.parse(readFileSync(DICT, "utf8")).entries as DictEntry[];
  const rl = buildLexicon({ glossItems: { ...glossItems, "전": { path: "/m/before.json" } }, dictionary: real });
  const p = planSentence("편지를 전하기 위해 우산을 쓰고 가방을 메고 백화점에 갔어요", rl);
  const lemmas = p.order.map((t) => t.lemma);
  assert.ok(lemmas.includes("전하다") && lemmas.includes("위하다"), lemmas.join(","));
  assert.ok(!lemmas.includes("전") && !lemmas.includes("위") && !lemmas.includes("무고"), lemmas.join(","));
  assert.notEqual(p.order.find((t) => t.lemma === "전하다")?.status, "playable"); // '전(앞)' 동작을 빌려 쓰지 않음
  assert.deepEqual(planSentence("시장에를 갔니?", rl).order.map((t) => t.lemma), ["시장", "가다"]);
});

test("명사 동작 빌려 쓰기는 뜻이 같을 때만 (운전하다 → 운전)", () => {
  const d: DictEntry[] = [
    { id: 1, w: [["운전"]], c: "사회생활 > 교통", d: true, h: "", j: null },
    { id: 2, w: [["운전하다"]], c: "사회생활 > 교통", d: true, h: "", j: null },
  ];
  const l = buildLexicon({ glossItems: { "운전": { path: "/m/drive.json" } }, dictionary: d });
  assert.equal(planSentence("운전해요", l).order[0].status, "playable");
});

test("'ㄹ 수 있다/없다'는 수어 가능/불가능으로 바꾼다('수'를 옷의 부분 등으로 보지 않음)", () => {
  const lx = buildLexicon({ glossItems: { ...glossItems, "가능": { path: "/m/can.json" }, "불가능": { path: "/m/cannot.json" } },
    dictionary: [...dictionary, { id: 99, w: [["수", "옷의"]], c: "의생활 > 옷의 부분", d: true, h: "", j: null }] });
  assert.deepEqual(planSentence("택시 탈 수 있어요?", lx).order.map((t) => t.lemma), ["택시", "타다", "가능"]);
  assert.deepEqual(planSentence("지하철 갈 수 없어요", lx).order.map((t) => t.lemma), ["지하철", "가다", "불가능"]);
});

test("N호선은 AI-Hub 표기 'N호' 동작으로(있는 노선만), 없으면 지숫자 필요로 남긴다", () => {
  const lx = buildLexicon({ glossItems: { ...glossItems, "1호": { path: "/m/line1.json" } }, dictionary });
  const one = planSentence("1호선 타요", lx);
  assert.equal(one.order[0].lemma, "1호");
  assert.equal(one.order[0].status, "playable");
  const four = planSentence("4호선 타요", lx);
  assert.equal(four.order[0].lemma, "4호선");
  assert.notEqual(four.order[0].status, "playable");
});

test("돕다는 '도와'로 활용하고, 높임 보조용언 '드리다'는 떼어 낸다", () => {
  assert.ok(predicateStems("돕다").includes("도와"));
  assert.ok(predicateStems("춥다").includes("추워"));
  const lx = buildLexicon({ glossItems: { ...glossItems, "도와주다": { path: "/m/help.json" } }, dictionary: [...dictionary, { id: 98, w: [["돕다"]], c: "인간", d: true, h: "", j: null }] });
  const p = planSentence("도와드릴까요?", lx);
  // 돕다 → 유의어 도와주다(동작 있음)까지 이어져 재생된다
  assert.equal(p.order[0].lemma, "도와주다");
  assert.equal(p.order[0].status, "playable");
});

// 지문자 데이터(2026-11-05): 숫자만 있는 말·역 이름 동작
test("지숫자: '5'는 변이형 번호로 지우지 않고, '5번'처럼 단위 동작이 없으면 숫자 동작으로", () => {
  assert.equal(strip("5"), "5");
  assert.equal(strip("12"), "12");
  assert.equal(strip("가방2"), "가방");
  assert.equal(strip("종로3가"), "종로3가");
  const l = buildLexicon({
    glossItems: { "5": { path: "/m/5.json" }, "5분": { path: "/m/5m.json" }, "사당": { path: "/m/sadang.json" }, "곳": { path: "/m/place.json" }, "내리다": { path: "/m/off.json" } },
    dictionary: [{ id: 1, w: [["역"]], c: "사회생활 > 교통", d: true, h: "", j: null }],
  });
  assert.equal(numberGloss("5번", l), "5");
  assert.equal(numberGloss("5분", l), "5분");
  assert.equal(numberGloss("7번", l), "7번");
  assert.deepEqual(planSentence("사당역에서 5분 뒤에 내려요", l).order.filter((t) => t.status === "playable").map((t) => t.lemma), ["5분", "사당", "곳", "내리다"]); // 시간 표현은 앞으로
});

// 사용자 피드백(2026-11-05): 확인 상자를 없애면서 "ㅇㅇ"가 '왜'로 바뀌어 그대로 재생되던 문제
test("자음·모음만 있는 말(ㅇㅇ, ㅋㅋ)은 오타 교정하지 않고 군말로 뺌", () => {
  const l = buildLexicon({ glossItems: { "화장실": { path: "/m/wc.json" }, "왜": { path: "/m/why.json" } } });
  assert.deepEqual(planSentence("ㅇㅇ 화장실 ㅋㅋ", l).order.map((t) => t.lemma), ["화장실"]);
});

// 사용자 피드백(2026-11-06): 시연 대사를 자연스러운 말투로("가시면 됩니다", "구매하세요", "도움이 필요하신가요")
test("높임 '-시-'·'-면 되다'·같은 뜻 단어(도움·구매)", () => {
  const d: DictEntry[] = [
    { id: 1, w: [["가시"]], c: "식물", d: true, h: "", j: null }, { id: 2, w: [["가시다"]], c: "기타", d: true, h: "", j: null },
    { id: 3, w: [["가다"]], c: "인간", d: true, h: "", j: null }, { id: 4, w: [["되다"]], c: "기타", d: true, h: "", j: null },
    { id: 5, w: [["구매"], ["사다"]], c: "경제", d: true, h: "", j: null }, { id: 6, w: [["도움"]], c: "사회", d: true, h: "", j: null },
    { id: 7, w: [["필요"]], c: "개념", d: true, h: "", j: null },
  ];
  const l = buildLexicon({ dictionary: d, glossItems: { "가다": { path: "/m/go.json" }, "타다": { path: "/m/ride.json" }, "되다": { path: "/m/be.json" },
    "사다": { path: "/m/buy.json" }, "도와주다": { path: "/m/help.json" }, "필요": { path: "/m/need.json" } } });
  const g = (s: string) => planSentence(s, l).order.map((t) => t.lemma);
  assert.deepEqual(g("타고 가시면 됩니다"), ["타다", "가다"]);
  assert.deepEqual(g("구매하세요"), ["사다"]);
  assert.deepEqual(g("도움이 필요하신가요?"), ["도와주다", "필요"]);
});

test("'다시'는 부사 그대로, 따로 떨어진 '하다'와 '-면 되다'는 뺌", () => {
  const d: DictEntry[] = [{ id: 1, w: [["달다"]], c: "기타", d: true, h: "", j: null }, { id: 2, w: [["하다"]], c: "기타", d: true, h: "", j: null },
    { id: 3, w: [["되다"]], c: "기타", d: true, h: "", j: null }];
  const l = buildLexicon({ dictionary: d, glossItems: { "다시": { path: "/m/again.json" }, "달다": { path: "/m/hang.json" }, "충전": { path: "/m/charge.json" },
    "여기": { path: "/m/here.json" }, "되다": { path: "/m/be.json" } } });
  assert.deepEqual(planSentence("다시", l).order.map((t) => t.lemma), ["다시"]);
  assert.deepEqual(planSentence("충전은 여기서 하시면 됩니다", l).order.map((t) => t.lemma), ["충전", "여기"]);
});
