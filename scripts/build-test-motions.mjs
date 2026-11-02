/**
 * 개발용 테스트 동작 생성기.
 *
 * ⚠ 여기서 만드는 동작은 모두 "관절 제어 확인용"이며 한국수어가 아니다.
 *   출력 파일의 kind는 항상 "test"로 고정된다.
 *
 * 좌표계 (VRM 1.0 정규화 본, T-포즈가 회전 0):
 *   아바타는 +Z를 바라보고, 아바타의 왼쪽이 +X, 위가 +Y.
 *   - 왼팔은 +X 방향으로 뻗어 있음 → Z축 음(-) 회전이 팔을 내림
 *   - 오른팔은 -X 방향 → Z축 양(+) 회전이 팔을 내림
 *   - 손가락 굽힘: 왼손 Z-, 오른손 Z+ (손바닥 쪽으로)
 *   각도는 [X, Y, Z] 도(degree), Euler 순서 XYZ.
 *
 * 실행: npm run motions:build
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { Euler, Quaternion, MathUtils } from "three";

const OUT_MOTIONS = new URL("../public/motions/test/", import.meta.url);
const OUT_REST = new URL("../src/lib/restPose.generated.json", import.meta.url);

const deg = MathUtils.degToRad;
const quat = ([x, y, z]) => {
  const q = new Quaternion().setFromEuler(new Euler(deg(x), deg(y), deg(z), "XYZ"));
  return [q.x, q.y, q.z, q.w].map((v) => Math.round(v * 1e6) / 1e6);
};
const toBones = (pose) => Object.fromEntries(Object.entries(pose).map(([b, e]) => [b, quat(e)]));

// ── 좌우 대칭 헬퍼 ───────────────────────────────────────
// 왼쪽 기준 각도를 주면 오른쪽은 Y·Z 부호를 뒤집어 거울 대칭으로 만든다.
const mirror = ([x, y, z]) => [x, -y, -z];
const both = (name, left) => ({ [`left${name}`]: left, [`right${name}`]: mirror(left) });

const FINGERS = ["Index", "Middle", "Ring", "Little"];
const SEGS = ["Proximal", "Intermediate", "Distal"];

/** 한쪽 손 손가락 굽힘. amount: 0(폄)~1(쥠). side: "left" | "right" */
function fingers(side, amounts) {
  const out = {};
  const sign = side === "left" ? -1 : 1;
  FINGERS.forEach((f, i) => {
    const a = amounts[i];
    SEGS.forEach((s, j) => {
      const max = [80, 95, 60][j];
      out[`${side}${f}${s}`] = [0, 0, sign * max * a];
    });
  });
  const t = amounts[4] ?? 0; // 엄지
  out[`${side}ThumbMetacarpal`] = [0, sign * -25 * t, sign * 10 * t];
  out[`${side}ThumbProximal`] = [0, sign * -35 * t, 0];
  out[`${side}ThumbDistal`] = [0, sign * -45 * t, 0];
  return out;
}
const hands = (amounts) => ({ ...fingers("left", amounts), ...fingers("right", amounts) });
const OPEN = [0, 0, 0, 0, 0];
const FIST = [1, 1, 1, 1, 1];

// ── 기본 자세 (수어 아님: 팔을 자연스럽게 내린 대기 자세) ─────
const REST = {
  ...both("UpperArm", [0, 0, -72]),
  ...both("LowerArm", [0, -8, 0]),
  ...both("Hand", [0, 0, 0]),
  ...hands([0.15, 0.18, 0.2, 0.22, 0.1]),
};

// ── 가슴 앞으로 양손을 든 자세 (손바닥이 정면을 향하도록) ─────
const HANDS_UP = {
  ...both("UpperArm", [0, 15, -62]),
  ...both("LowerArm", [0, -115, 0]),
  ...both("Hand", [-90, 0, 0]),
};

function clip(motion_id, label, frames) {
  return {
    format: "sueon-keyframes/v1",
    motion_id,
    kind: "test",
    label,
    space: "vrm-normalized-humanoid",
    duration: frames[frames.length - 1][0],
    source: "수어온 개발용 직접 제작 키프레임 (scripts/build-test-motions.mjs). 한국수어 아님.",
    keyframes: frames.map(([t, pose]) => ({ t, bones: toBones(pose) })),
  };
}

// 테스트 1: 손가락 관절 — 펴기/쥐기 후 검지부터 하나씩 접기
const fingerCurl = clip("TEST-FINGER-CURL", "손가락 관절 테스트", [
  [0.0, { ...HANDS_UP, ...hands(OPEN) }],
  [0.8, { ...HANDS_UP, ...hands(OPEN) }],
  [1.4, { ...HANDS_UP, ...hands(FIST) }],
  [2.0, { ...HANDS_UP, ...hands(OPEN) }],
  [2.6, { ...HANDS_UP, ...hands(FIST) }],
  [3.2, { ...HANDS_UP, ...hands(OPEN) }],
  [3.7, { ...HANDS_UP, ...hands([1, 0, 0, 0, 0]) }],
  [4.2, { ...HANDS_UP, ...hands([1, 1, 0, 0, 0]) }],
  [4.7, { ...HANDS_UP, ...hands([1, 1, 1, 0, 0]) }],
  [5.2, { ...HANDS_UP, ...hands([1, 1, 1, 1, 0]) }],
  [5.7, { ...HANDS_UP, ...hands([1, 1, 1, 1, 1]) }],
  [6.4, { ...HANDS_UP, ...hands(OPEN) }],
]);

// 테스트 2: 팔·손목 — 오른팔 들기, 팔꿈치 굽히기, 손목 좌우, 왼팔 반복
const R = (name, e) => ({ [`right${name}`]: e });
const L = (name, e) => ({ [`left${name}`]: e });
const restArms = { ...both("UpperArm", REST.leftUpperArm), ...both("LowerArm", REST.leftLowerArm), ...both("Hand", [0, 0, 0]) };
const armWrist = clip("TEST-ARM-WRIST", "팔·손목 관절 테스트", [
  [0.0, { ...restArms, ...hands(OPEN) }],
  [0.8, { ...restArms, ...R("UpperArm", [0, 0, 20]), ...hands(OPEN) }],
  [1.6, { ...restArms, ...R("UpperArm", [0, 0, 20]), ...R("LowerArm", [0, 0, 70]), ...hands(OPEN) }],
  [2.1, { ...restArms, ...R("UpperArm", [0, 0, 20]), ...R("LowerArm", [0, 0, 70]), ...R("Hand", [0, 0, 35]), ...hands(OPEN) }],
  [2.6, { ...restArms, ...R("UpperArm", [0, 0, 20]), ...R("LowerArm", [0, 0, 70]), ...R("Hand", [0, 0, -35]), ...hands(OPEN) }],
  [3.1, { ...restArms, ...R("UpperArm", [0, 0, 20]), ...R("LowerArm", [0, 0, 70]), ...R("Hand", [0, 0, 35]), ...hands(OPEN) }],
  [3.9, { ...restArms, ...hands(OPEN) }],
  [4.7, { ...restArms, ...L("UpperArm", [0, 0, -20]), ...L("LowerArm", [0, 0, -70]), ...hands(OPEN) }],
  [5.2, { ...restArms, ...L("UpperArm", [0, 0, -20]), ...L("LowerArm", [0, 0, -70]), ...L("Hand", [0, 0, -35]), ...hands(OPEN) }],
  [5.7, { ...restArms, ...L("UpperArm", [0, 0, -20]), ...L("LowerArm", [0, 0, -70]), ...L("Hand", [0, 0, 35]), ...hands(OPEN) }],
  [6.5, { ...restArms, ...hands(OPEN) }],
]);

mkdirSync(OUT_MOTIONS, { recursive: true });
writeFileSync(new URL("test_finger_curl.json", OUT_MOTIONS), JSON.stringify(fingerCurl, null, 1));
writeFileSync(new URL("test_arm_wrist.json", OUT_MOTIONS), JSON.stringify(armWrist, null, 1));
writeFileSync(OUT_REST, JSON.stringify(toBones(REST), null, 1));
console.log("생성 완료: test_finger_curl.json, test_arm_wrist.json, restPose.generated.json");
