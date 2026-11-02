import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchSentence, playableEntries } from "../src/lib/matcher.ts";

const load = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const entries = load("../data/expressions.json").entries;
const sources = load("../data/aihub_morphemes.json").items;

for (const sample of sources) {
  test(`${sample.word_id} '${sample.korean}' 같은 촬영본(REAL02) 표제어-모션 대응 (정확도 미검증)`, () => {
    const segments = matchSentence(sample.korean, entries);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].status, "playable");
    const entry = playableEntries(segments)[0];
    assert.equal(entry.korean, sample.korean);
    assert.equal(entry.kind, "test");
    assert.equal(entry.verification_status, "not_sign_language");
    // 표제어·구간·모션 모두 같은 촬영본(REAL02_F)
    assert.equal(entry.motion_source_actor, "REAL02");
    assert.equal(sample.morpheme_actor, "REAL02");
    assert.equal(entry.label_motion_same_actor, true);
    assert.equal(sample.label_motion_same_actor, true);
    assert.equal(entry.motion_take, `NIA_SL_${sample.word_id}_REAL02_F`);
    assert.equal(entry.motion_quality, "experimental_unvalidated");
    assert.deepEqual(entry.gloss_interval_sec, [sample.gloss_start_sec, sample.gloss_end_sec]);
    assert.ok(entry.motion_path.startsWith("/motions/aihub_real02/"));
    if (entry.legacy_motion_path) assert.ok(entry.legacy_motion_path.includes("/stabilized/"));
    const clip = load(`../public${entry.motion_path}`);
    // AIHUB-SAMPLE- 접두어가 아니므로 기존 PoseSafety(몸통 회피 보정)가 적용되지 않는다
    assert.equal(clip.motion_id, `AIHUB-REAL02-${sample.word_id}`);
    assert.equal(clip.kind, "test");
    assert.equal(clip.retarget.take, entry.motion_take);
    // 같은 촬영본 형태소 구간(앞뒤 0.2초)으로 잘림
    assert.ok(clip.retarget.trim.startsWith(`morpheme ${entry.motion_take}`));
    const [a, b] = clip.retarget.source_frames;
    assert.ok(a <= Math.round(sample.gloss_start_sec * 30) && b >= Math.round(sample.gloss_end_sec * 30) - 1);
    assert.ok(clip.keyframes.length >= 30);
    if (entry.legacy_motion_path) {
      const legacy = load(`../public${entry.legacy_motion_path}`);
      assert.equal(legacy.processing.source_actor_verified, false);
    }
  });
}

test("미확인 표현을 자동으로 수어 표현에 치환하지 않는다", () => {
  const seg = matchSentence("운전면허증을 갱신해요", entries);
  assert.deepEqual(seg.map((s) => s.status), ["unsupported", "unsupported"]);
});

// 정적 경로 검증이다. 실제 Next.js proxy 차단 확인은 빌드된 서버에서 수행해야 한다.
test("기존 원본과 새 안정화 파생 모션 모두 공개 배포 차단 경로에 포함된다", () => {
  const proxySource = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
  assert.match(proxySource, /\/motions\/sample\/:path\*/);
  assert.match(proxySource, /\/motions\/stabilized\/:path\*/);
  assert.match(proxySource, /\/motions\/aihub_real02\/:path\*/);
  assert.match(proxySource, /\/motions\/aihub_gloss\/:path\*/);
  assert.match(proxySource, /NODE_ENV === "production"/);
});

// 실제 촬영 문장(REAL SEN) 클립: 검색·재생일 뿐 번역·생성이 아님을 데이터로 보장한다
test("문장 클립은 # 명령으로만 호출되고 같은 촬영본 형태소의 gloss 구간을 가진다", () => {
  const sens = entries.filter((e: { expression_id: string }) => e.expression_id.startsWith("AIHUB-SAMPLE-SEN"));
  assert.ok(sens.length >= 1);
  for (const e of sens) {
    assert.ok(e.match.every((m: string) => m.startsWith("#SEN")), "한국어 단어로 매칭되면 안 됨");
    assert.match(e.korean, /한국어 원문 미확보/);
    const clip = load(`../public${e.motion_path}`);
    assert.ok(clip.retarget.trim.startsWith(`morpheme ${e.motion_take}`));
    const raw = load(`../data/morphemes/${e.motion_take}_morpheme.json`);
    const glosses = [...raw.data].sort((a: { start: number }, b: { start: number }) => a.start - b.start)
      .flatMap((s: { attributes: { name: string }[] }) => s.attributes.map((x) => x.name));
    assert.deepEqual(clip.retarget.gloss_segments.map((g: [string]) => g[0]), glosses);
    assert.deepEqual(e.gloss_sequence, glosses);
    for (const [, a, b] of clip.retarget.gloss_segments) assert.ok(a >= 0 && b <= clip.duration + 1e-6 && a < b);
  }
});
