import type { Quat } from "./types";
import rest from "./restPose.generated.json";

/**
 * 기본 대기 자세 (팔을 내린 자세). 한국수어 동작이 아니다.
 * scripts/build-test-motions.mjs 에서 생성된다.
 */
function toPose(raw: Record<string, number[]>): Record<string, Quat> {
  const out: Record<string, Quat> = {};
  for (const [bone, q] of Object.entries(raw)) {
    if (q.length !== 4) throw new Error(`기본 자세 데이터 오류: ${bone}`);
    out[bone] = [q[0], q[1], q[2], q[3]];
  }
  return out;
}

export const REST_POSE = toPose(rest);
