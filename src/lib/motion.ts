import { VRMHumanBoneList } from "@pixiv/three-vrm";
import type { ExpressionEntry, MotionClip, Quat } from "./types";

const BONE_NAMES = new Set<string>(VRMHumanBoneList);

export class MotionDataError extends Error {}

/** 동작 JSON의 구조를 검사한다. 형식이 틀린 데이터는 재생하지 않는다. */
export function validateClip(raw: unknown): MotionClip {
  const fail = (msg: string): never => {
    throw new MotionDataError(msg);
  };
  if (!raw || typeof raw !== "object") fail("동작 파일이 JSON 객체가 아닙니다.");
  const c = raw as Partial<MotionClip>;

  if (c.format !== "sueon-keyframes/v1") fail(`지원하지 않는 동작 형식입니다: ${String(c.format)}`);
  if (c.kind !== "ksl" && c.kind !== "test") fail("동작 종류(kind)가 ksl 또는 test가 아닙니다.");
  if (c.space !== "vrm-normalized-humanoid") fail("본 회전 공간(space)이 올바르지 않습니다.");
  if (typeof c.duration !== "number" || c.duration <= 0) fail("재생 시간(duration)이 올바르지 않습니다.");
  if (!Array.isArray(c.keyframes) || c.keyframes.length < 2) fail("키프레임이 2개 이상 필요합니다.");

  let prev = -Infinity;
  for (const kf of c.keyframes!) {
    if (typeof kf.t !== "number" || kf.t < prev) fail("키프레임 시간이 오름차순이 아닙니다.");
    if (kf.t > c.duration! + 1e-6) fail("키프레임 시간이 duration을 넘습니다.");
    prev = kf.t;
    for (const [bone, q] of Object.entries(kf.bones ?? {})) {
      if (!BONE_NAMES.has(bone)) fail(`알 수 없는 본 이름입니다: ${bone}`);
      if (!Array.isArray(q) || q.length !== 4 || q.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
        fail(`${bone}의 회전값이 [x,y,z,w] 형식이 아닙니다.`);
      }
      const len = Math.hypot(...(q as Quat));
      if (Math.abs(len - 1) > 1e-3) fail(`${bone}의 쿼터니언이 정규화되지 않았습니다.`);
    }
  }
  return c as MotionClip;
}

/**
 * 표현에 연결된 동작 파일을 불러온다.
 * 표현의 kind와 동작 파일의 kind가 다르면 거부한다
 * (테스트 동작이 한국수어 표현에 연결되는 사고를 막기 위함).
 */
export async function loadClipForEntry(entry: ExpressionEntry, useLegacy = false): Promise<MotionClip> {
  // useLegacy: 개발 비교용으로 이전 변환식 모션을 불러온다
  const path = useLegacy && entry.legacy_motion_path ? entry.legacy_motion_path : entry.motion_path;
  if (!path) throw new MotionDataError(`${entry.korean}: 연결된 동작 데이터가 없습니다.`);
  const res = await fetch(path);
  if (!res.ok) throw new MotionDataError(`${entry.korean}: 동작 파일을 불러오지 못했습니다 (HTTP ${res.status}).`);
  const clip = validateClip(await res.json());
  if (clip.kind !== entry.kind) {
    throw new MotionDataError(
      `${entry.korean}: 표현 종류(${entry.kind})와 동작 데이터 종류(${clip.kind})가 달라 재생하지 않습니다.`,
    );
  }
  return clip;
}
