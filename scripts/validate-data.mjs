/**
 * 표현 사전과 동작 데이터 검증 스크립트.
 * 실행: npm run data:validate
 *
 * 검사 규칙
 *  1. 모든 motion_path는 public/ 아래 실제 파일을 가리켜야 한다 (없는 경로 금지).
 *  2. supported=true 이면 motion_path와 source가 있어야 한다.
 *  3. motion_path=null 이면 supported=false 여야 한다.
 *  4. kind=test 표현은 verification_status=not_sign_language 여야 한다.
 *  5. kind=ksl 표현은 not_sign_language 상태를 가질 수 없다.
 *  6. 동작 파일의 kind는 표현의 kind와 같아야 한다 (테스트 동작이 수어로 연결되는 것 방지).
 *  7. 동작 파일 구조: 형식, 본 이름, 정규화된 쿼터니언, 오름차순 시간.
 *  8. expression_id와 match 문자열은 중복될 수 없다.
 */
import { readFileSync, existsSync } from "node:fs";
import { VRMHumanBoneList } from "@pixiv/three-vrm";

const root = new URL("../", import.meta.url);
const registry = JSON.parse(readFileSync(new URL("data/expressions.json", root), "utf8"));
const BONES = new Set(VRMHumanBoneList);
const STATUSES = new Set(["verified", "unverified", "data_pending", "not_sign_language"]);

const errors = [];
const err = (id, msg) => errors.push(`[${id}] ${msg}`);
const ids = new Set();
const surfaces = new Map();

function checkClip(id, clip) {
  if (clip.format !== "sueon-keyframes/v1") err(id, `동작 형식 오류: ${clip.format}`);
  if (clip.space !== "vrm-normalized-humanoid") err(id, `회전 공간 오류: ${clip.space}`);
  if (!(clip.duration > 0)) err(id, "duration이 0보다 커야 합니다");
  if (!Array.isArray(clip.keyframes) || clip.keyframes.length < 2) return err(id, "키프레임이 2개 이상 필요합니다");
  let prev = -Infinity;
  for (const kf of clip.keyframes) {
    if (kf.t < prev) err(id, `키프레임 시간이 오름차순이 아닙니다 (t=${kf.t})`);
    if (kf.t > clip.duration + 1e-6) err(id, `키프레임 시간이 duration을 넘습니다 (t=${kf.t})`);
    prev = kf.t;
    for (const [bone, q] of Object.entries(kf.bones)) {
      if (!BONES.has(bone)) err(id, `알 수 없는 본: ${bone}`);
      if (!Array.isArray(q) || q.length !== 4) { err(id, `${bone} 회전값 형식 오류`); continue; }
      if (Math.abs(Math.hypot(...q) - 1) > 1e-3) err(id, `${bone} 쿼터니언 비정규화 (t=${kf.t})`);
    }
  }
}

for (const e of registry.entries) {
  const id = e.expression_id ?? "(id 없음)";
  if (ids.has(id)) err(id, "expression_id 중복");
  ids.add(id);
  if (e.kind !== "ksl" && e.kind !== "test") err(id, `kind 오류: ${e.kind}`);
  if (!STATUSES.has(e.verification_status)) err(id, `verification_status 오류: ${e.verification_status}`);

  for (const s of e.match ?? []) {
    if (surfaces.has(s)) err(id, `match 문자열 "${s}"이(가) ${surfaces.get(s)}와 중복`);
    surfaces.set(s, id);
  }

  if (e.kind === "test" && e.verification_status !== "not_sign_language")
    err(id, "테스트 동작은 not_sign_language 상태여야 합니다");
  if (e.kind === "ksl" && e.verification_status === "not_sign_language")
    err(id, "한국수어 표현에 not_sign_language 상태를 쓸 수 없습니다");

  if (e.motion_path === null) {
    if (e.supported) err(id, "동작 데이터가 없는데 supported=true 입니다");
    continue;
  }
  if (e.supported && !e.source) err(id, "supported=true 이지만 데이터 출처(source)가 없습니다");

  const file = new URL(`public${e.motion_path}`, root);
  if (!existsSync(file)) { err(id, `동작 파일이 존재하지 않습니다: ${e.motion_path}`); continue; }
  let clip;
  try { clip = JSON.parse(readFileSync(file, "utf8")); } catch { err(id, "동작 파일 JSON 파싱 실패"); continue; }
  if (clip.kind !== e.kind) err(id, `표현 kind(${e.kind})와 동작 파일 kind(${clip.kind})가 다릅니다`);
  checkClip(id, clip);
}

const ksl = registry.entries.filter((e) => e.kind === "ksl");
const kslPlayable = ksl.filter((e) => e.supported && e.motion_path);
const tests = registry.entries.filter((e) => e.kind === "test");
console.log(`표현 ${registry.entries.length}건 검사`);
console.log(`  한국수어(ksl) ${ksl.length}건 중 동작 데이터 연결: ${kslPlayable.length}건`);
console.log(`  테스트 동작(test, 한국수어 아님): ${tests.length}건`);

if (errors.length) {
  console.error(`\n오류 ${errors.length}건:`);
  errors.forEach((m) => console.error("  " + m));
  process.exit(1);
}
console.log("\n검증 통과");
