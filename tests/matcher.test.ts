import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchSentence, playableEntries } from "../src/lib/matcher.ts";

const registry = JSON.parse(readFileSync(new URL("../data/expressions.json", import.meta.url), "utf8"));
const entries = registry.entries;

test("등록됐지만 동작 데이터가 없는 한국수어 표현은 no_motion으로 표시되고 재생되지 않는다", () => {
  const seg = matchSentence("안녕하세요", entries);
  assert.equal(seg.length, 1);
  assert.equal(seg[0].status, "no_motion");
  assert.equal(seg[0].entry.expression_id, "KSL-0001");
  assert.equal(playableEntries(seg).length, 0);
});

test("긴 표현이 짧은 표현보다 우선한다 (안녕하세요 > 안녕)", () => {
  assert.equal(matchSentence("안녕하세요!", entries)[0].entry.korean, "안녕하세요");
});

test("조사가 붙은 표현도 같은 표현으로 찾는다", () => {
  const seg = matchSentence("화장실은 어디예요?", entries);
  assert.deepEqual(seg.map((s) => s.entry?.expression_id), ["KSL-0005", "KSL-0006"]);
});

test("사전에 없는 어절은 unsupported로 남고 다른 표현으로 대체되지 않는다", () => {
  const seg = matchSentence("안녕히 가세요", entries);
  assert.deepEqual(seg.map((s) => s.status), ["unsupported", "unsupported"]);
  assert.equal(playableEntries(seg).length, 0);
});

test("독립 관절 테스트는 # 명령어만 사용하고 kind=test로 구분된다", () => {
  const seg = matchSentence("#손가락테스트 #팔테스트", entries);
  const play = playableEntries(seg);
  assert.equal(play.length, 2);
  assert.ok(play.every((e) => e.kind === "test" && e.verification_status === "not_sign_language"));
  assert.equal(matchSentence("손가락테스트", entries)[0].status, "unsupported");
});

test("지원·미지원이 섞인 문장은 어절별로 구분된다", () => {
  const seg = matchSentence("감사합니다 내일 봐요", entries);
  assert.deepEqual(seg.map((s) => s.status), ["no_motion", "unsupported", "unsupported"]);
});
