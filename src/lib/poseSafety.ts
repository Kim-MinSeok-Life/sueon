import * as THREE from "three";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import {
  bodyEscapeLocal,
  WRIST_SWING_LIMIT_DEG,
  WRIST_TWIST_LIMIT_DEG,
  MAX_UPPER_ARM_DEVIATION_DEG,
  MAX_LOWER_ARM_DEVIATION_DEG,
} from "./poseSafetyMath";

const RAD = Math.PI / 180;
const IDENTITY = new THREE.Quaternion();
const MAX_TARGET_SHIFT = 0.16; // 보정이 실제 궤적을 과도하게 변경하지 않도록 제한 (VRM 단위)

function node(vrm: VRM, name: VRMHumanBoneName) {
  return vrm.humanoid.getNormalizedBoneNode(name);
}

/** 손목 회전을 비틀림(X)과 꺾임으로 분리해 각각 보수적인 범위 안으로 제한한다. */
export function limitWristRotation(q: THREE.Quaternion): boolean {
  q.normalize();
  // VRM 정규화 휴머노이드의 팔은 로컬 X 축 방향으로 뻗는다.
  const twist = new THREE.Quaternion(q.x, 0, 0, q.w).normalize();
  if (!Number.isFinite(twist.x) || !Number.isFinite(twist.w)) return false;
  const swing = q.clone().multiply(twist.clone().invert()).normalize();
  const swingAngle = IDENTITY.angleTo(swing);
  const twistAngle = 2 * Math.atan2(twist.x, twist.w);
  const wrapped = Math.atan2(Math.sin(twistAngle), Math.cos(twistAngle));
  const cappedTwist = THREE.MathUtils.clamp(wrapped, -WRIST_TWIST_LIMIT_DEG * RAD, WRIST_TWIST_LIMIT_DEG * RAD);
  const cappedSwing = swingAngle > WRIST_SWING_LIMIT_DEG * RAD
    ? IDENTITY.clone().slerp(swing, (WRIST_SWING_LIMIT_DEG * RAD) / swingAngle)
    : swing;
  const next = cappedSwing.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), cappedTwist)).normalize();
  const changed = q.angleTo(next) > 0.001;
  if (changed) q.copy(next);
  return changed;
}

/**
 * AI-Hub 근사 모션 전용, 화면 재생 시의 보수적 관절 안전 보정.
 * 본 손상이나 실제 물리 충돌 해결이 아닌 데모 품질 개선 목적이다.
 * 손가락 키프레임과 원본 모션 파일은 변경하지 않는다.
 */
export class PoseSafety {
  private vrm: VRM;
  private last = { wrist: 0, torso: 0, unresolved: 0 };

  constructor(vrm: VRM) { this.vrm = vrm; }
  getStats() { return { ...this.last }; }

  correct() {
    this.last = { wrist: 0, torso: 0, unresolved: 0 };
    const { vrm } = this;
    for (const side of ["left", "right"] as const) {
      const hand = node(vrm, `${side}Hand`);
      if (hand && limitWristRotation(hand.quaternion)) this.last.wrist++;
    }

    // 몸통 영역은 실제 아바타의 어깨폭·골반·목 위치에서 매 프레임 계산한다.
    const hips = node(vrm, "hips");
    const neck = node(vrm, "neck");
    const chest = node(vrm, "chest");
    const leftShoulder = node(vrm, "leftUpperArm");
    const rightShoulder = node(vrm, "rightUpperArm");
    if (!hips || !neck || !chest || !leftShoulder || !rightShoulder) return;

    vrm.scene.updateMatrixWorld(true);
    const hipPos = hips.getWorldPosition(new THREE.Vector3());
    const neckPos = neck.getWorldPosition(new THREE.Vector3());
    const center = hipPos.clone().lerp(neckPos, 0.58);
    const centerFrame = chest.getWorldQuaternion(new THREE.Quaternion());
    const invFrame = centerFrame.clone().invert();
    const shoulderWidth = leftShoulder.getWorldPosition(new THREE.Vector3())
      .distanceTo(rightShoulder.getWorldPosition(new THREE.Vector3()));
    const torsoHeight = hipPos.distanceTo(neckPos);
    const radius = {
      x: THREE.MathUtils.clamp(shoulderWidth * 0.82, 0.13, 0.23),
      y: THREE.MathUtils.clamp(torsoHeight * 0.55, 0.21, 0.36),
      z: THREE.MathUtils.clamp(shoulderWidth * 0.55, 0.095, 0.17),
    };

    for (const side of ["left", "right"] as const) {
      const hand = node(vrm, `${side}Hand`);
      const lower = node(vrm, `${side}LowerArm`);
      const upper = node(vrm, `${side}UpperArm`);
      if (!hand || !lower || !upper) continue;
      const current = hand.getWorldPosition(new THREE.Vector3());
      // 손목만 검사하면 손끝이 흉부를 뚫을 수 있으므로 손가락 말단 본도 확인한다.
      // 이는 손끝 메시 전체를 검사하는 정밀 충돌 판정은 아니다.
      const samples = [hand];
      for (const finger of ["Thumb", "Index", "Middle", "Ring", "Little"]) {
        const tip = node(vrm, `${side}${finger}Distal` as VRMHumanBoneName);
        if (tip) samples.push(tip);
      }
      let offset = new THREE.Vector3();
      for (const sample of samples) {
        const local = sample.getWorldPosition(new THREE.Vector3()).sub(center).applyQuaternion(invFrame);
        const correction = bodyEscapeLocal(local, radius);
        if (!correction) continue;
        const candidate = new THREE.Vector3(correction.x, correction.y, correction.z);
        if (candidate.lengthSq() > offset.lengthSq()) offset = candidate;
      }
      if (offset.lengthSq() < 0.000001) continue;
      offset.clampLength(0, MAX_TARGET_SHIFT).applyQuaternion(centerFrame);
      const target = current.clone().add(offset);
      const worldHandBefore = hand.getWorldQuaternion(new THREE.Quaternion());
      const upperBefore = upper.quaternion.clone();
      const lowerBefore = lower.quaternion.clone();

      // 손목을 몸통 밖으로 옮길 때 손을 직접 평행이동하면 팔과 분리된다.
      // 팔꿈치→어깨의 CCD 관절 회전으로 손 위치를 조금씩 맞춘다.
      for (let iteration = 0; iteration < 5; iteration++) {
        for (const [joint, original, maxDegrees] of [
          [lower, lowerBefore, MAX_LOWER_ARM_DEVIATION_DEG],
          [upper, upperBefore, MAX_UPPER_ARM_DEVIATION_DEG],
        ] as const) {
          const pivot = joint.getWorldPosition(new THREE.Vector3());
          const wrist = hand.getWorldPosition(new THREE.Vector3());
          const a = wrist.sub(pivot);
          const b = target.clone().sub(pivot);
          if (a.lengthSq() < 1e-8 || b.lengthSq() < 1e-8) continue;
          const worldDelta = new THREE.Quaternion().setFromUnitVectors(a.normalize(), b.normalize());
          const parentWorld = joint.parent?.getWorldQuaternion(new THREE.Quaternion());
          if (!parentWorld) continue;
          const localDelta = parentWorld.clone().invert().multiply(worldDelta).multiply(parentWorld);
          const proposed = localDelta.multiply(joint.quaternion.clone()).normalize();
          const maxDelta = maxDegrees * RAD;
          joint.quaternion.copy(original).rotateTowards(proposed, maxDelta);
          joint.updateWorldMatrix(true, true);
        }
        if (hand.getWorldPosition(new THREE.Vector3()).distanceToSquared(target) < 0.000025) break;
      }

      // 팔이 바뀌어도 기존의 제한된 손바닥 방향이 유지되도록 손목 로컬 회전을 갱신한다.
      const parentWorld = hand.parent?.getWorldQuaternion(new THREE.Quaternion());
      if (parentWorld) {
        hand.quaternion.copy(parentWorld.invert().multiply(worldHandBefore));
        limitWristRotation(hand.quaternion);
      }
      hand.updateWorldMatrix(true, true);
      this.last.torso++;
      // 보정 후에도 손/손끝이 몸통 내부면 미해결로 기록한다.
      // 팔 회전을 상한 이상으로 강제하면 수어 동작이 크게 왜곡되므로 멈춘다.
      if (samples.some((sample) => {
        const updated = sample.getWorldPosition(new THREE.Vector3()).sub(center).applyQuaternion(invFrame);
        return bodyEscapeLocal(updated, radius, 0) !== null;
      })) this.last.unresolved++;
    }
  }
}
