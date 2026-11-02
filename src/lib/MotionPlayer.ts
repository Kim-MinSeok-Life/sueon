import * as THREE from "three";
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import type { MotionClip, Quat } from "./types";
import { REST_POSE } from "./restPose";
import { PoseSafety } from "./poseSafety";

/**
 * 키프레임 동작 플레이어 (자체 구현, 외부 서비스 없음).
 *
 * 매 프레임 update(dt)에서 현재 시각의 본 회전을 계산해
 * VRM 정규화 본(normalized humanoid bone)에 직접 적용한다.
 * 이후 vrm.update()가 정규화 본 → 실제 스킨 본으로 회전을 옮긴다.
 *
 * - 키프레임 사이: 쿼터니언 slerp. 촘촘한 촬영 기반 동작(30fps)은 등속, 듬성한 수작업 동작은 smoothstep 이징
 * - 동작 시작(촘촘한 동작): 직전 자세 → 동작 첫 자세로 LEAD_IN초 동안 먼저 옮겨 간 뒤 동작을 처음부터 온전히 재생
 *   (예전처럼 섞으면서 동시에 진행하면 1초 안팎의 짧은 수어 앞부분이 뭉개짐 — 원본 영상 비교에서 확인)
 * - 동작 시작(듬성한 동작): 직전 자세에서 BLEND_IN초 동안 섞어 전환
 * - 문장 연속 재생: 문장에서 잘라 낸 수어 단어는 앞뒤 여유 구간을 줄이고 핵심 구간만 잇는다
 * - 마지막 동작 종료 후: BLEND_OUT초 동안 기본 자세로 복귀
 */

const BLEND_IN = 0.3;
// 문장 연속 재생: 첫 동작은 대기 자세에서 천천히 들어가고(손을 올리는 시간), 단어 사이 전환은 짧게
const BLEND_IN_FIRST = 0.45;
const BLEND_IN_CHAIN = 0.25;
const BLEND_OUT = 0.5;
const LEAD_IN = 0.3;
const LEAD_IN_FIRST = 0.35;
const LEAD_IN_CHAIN = 0.2;
const DENSE_STEP = 0.05; // 키프레임 간격이 이보다 촘촘하면 촬영 기반 동작으로 본다
const CHAIN_MARGIN = 0.05; // 연속 재생 시 수어 단어 핵심 구간 앞뒤로 남길 여유(초)

interface Track {
  times: number[];
  quats: THREE.Quaternion[];
}

interface PreparedClip {
  clip: MotionClip;
  tracks: Map<string, Track>;
  dense: boolean;
}

export type PlayerStatus = "idle" | "playing" | "paused" | "returning";

export interface PlayerState {
  status: PlayerStatus;
  clipIndex: number;
  clipCount: number;
  clipLabel: string | null;
  time: number;
  duration: number;
}

function toQuat(q: Quat) {
  return new THREE.Quaternion(q[0], q[1], q[2], q[3]);
}

function prepare(clip: MotionClip): PreparedClip {
  const tracks = new Map<string, Track>();
  for (const kf of clip.keyframes) {
    for (const [bone, q] of Object.entries(kf.bones)) {
      let tr = tracks.get(bone);
      if (!tr) tracks.set(bone, (tr = { times: [], quats: [] }));
      tr.times.push(kf.t);
      tr.quats.push(toQuat(q));
    }
  }
  const kf = clip.keyframes;
  const dense = kf.length > 2 && (kf[kf.length - 1].t - kf[0].t) / (kf.length - 1) <= DENSE_STEP;
  return { clip, tracks, dense };
}

const smooth = (x: number) => x * x * (3 - 2 * x);

function sampleTrack(tr: Track, t: number, out: THREE.Quaternion, ease = true) {
  const { times, quats } = tr;
  if (t <= times[0]) return out.copy(quats[0]);
  const last = times.length - 1;
  if (t >= times[last]) return out.copy(quats[last]);
  let i = 0;
  while (i < last && times[i + 1] < t) i++;
  const span = times[i + 1] - times[i];
  const a = span > 0 ? (t - times[i]) / span : 1;
  // 촘촘한 동작에 구간마다 이징을 걸면 33ms마다 감속·가속이 반복되어 움직임이 끊겨 보인다
  return out.slerpQuaternions(quats[i], quats[i + 1], ease ? smooth(a) : a);
}

/** 연속 재생에서 문장 수어 단어 클립의 핵심 구간(앞뒤 여유 줄임). 그 외에는 클립 전체 */
function playRange(p: PreparedClip, chained: boolean): [number, number] {
  const d = p.clip.duration;
  const seg = p.clip.retarget?.gloss_segments;
  if (!chained || !p.dense || !p.clip.retarget?.gloss || seg?.length !== 1) return [0, d];
  return [Math.max(0, seg[0][1] - CHAIN_MARGIN), Math.min(d, seg[0][2] + CHAIN_MARGIN)];
}

export class MotionPlayer {
  private vrm: VRM;
  private rest = new Map<string, THREE.Quaternion>();
  private controlled = new Set<string>();
  private queue: PreparedClip[] = [];
  private index = 0;
  private time = 0;
  private status: PlayerStatus = "idle";
  private blendFrom = new Map<string, THREE.Quaternion>();
  private blendTime = 0;
  private blendIn = BLEND_IN;
  private range: [number, number] = [0, 0];
  private leadIn = 0; // 이번 클립의 리드인 길이(초, 0이면 없음)
  private leading = false;
  private listeners = new Set<(s: PlayerState) => void>();
  private tmp = new THREE.Quaternion();
  private poseSafety: PoseSafety;
  private enablePoseSafety = true;
  private speed = 1;

  constructor(vrm: VRM) {
    this.vrm = vrm;
    this.poseSafety = new PoseSafety(vrm);
    for (const [bone, q] of Object.entries(REST_POSE)) {
      this.rest.set(bone, toQuat(q));
      this.controlled.add(bone);
    }
    this.applyPose((bone) => this.rest.get(bone)!);
  }

  /** 개발 중 보정 전/후를 비교하기 위한 전환. 샘플 모션에만 적용된다. */
  setPoseSafetyEnabled(value: boolean) { this.enablePoseSafety = value; }

  getPoseSafetyStats() { return this.poseSafety.getStats(); }

  /** 재생 속도(1 = 원래 속도). 원본 영상과 느리게 나란히 비교할 때 사용 */
  setSpeed(value: number) { this.speed = Math.max(0.05, Math.min(value, 2)); }

  /** 현재 재생(또는 마지막) 클립. 개발용 원본 관절 비교 화면에서 사용 */
  getCurrentClip(): MotionClip | null { return this.queue[this.index]?.clip ?? null; }

  onChange(fn: (s: PlayerState) => void) {
    this.listeners.add(fn);
    fn(this.getState());
    return () => this.listeners.delete(fn);
  }

  getState(): PlayerState {
    const cur = this.queue[this.index];
    return {
      status: this.status,
      clipIndex: this.index,
      clipCount: this.queue.length,
      clipLabel: cur?.clip.label ?? null,
      time: this.time,
      duration: cur?.clip.duration ?? 0,
    };
  }

  private emit() {
    const s = this.getState();
    this.listeners.forEach((fn) => fn(s));
  }

  /** 동작 목록을 설정하고 처음부터 재생한다. */
  load(clips: MotionClip[]) {
    this.queue = clips.map(prepare);
    for (const p of this.queue) p.tracks.forEach((_, bone) => this.controlled.add(bone));
    this.replay();
  }

  replay() {
    if (!this.queue.length) return;
    this.startClip(0);
  }

  pause() {
    if (this.status === "playing") {
      this.status = "paused";
      this.emit();
    }
  }

  resume() {
    if (this.status === "paused") {
      this.status = "playing";
      this.emit();
    }
  }

  /** 개발·자동 테스트용: 현재 클립의 t초 자세를 보간 없이 바로 적용하고 일시정지한다. */
  seek(t: number) {
    const cur = this.queue[this.index];
    if (!cur) return;
    this.time = Math.max(0, Math.min(t, cur.clip.duration));
    this.blendFrom.clear();
    this.leading = false;
    const sampled = new THREE.Quaternion();
    this.applyPose((bone) => {
      const tr = cur.tracks.get(bone);
      return tr ? sampleTrack(tr, this.time, sampled, !cur.dense) : this.restOf(bone);
    });
    this.status = "paused";
    this.emit();
  }

  /** 재생을 멈추고 기본 자세로 돌아간다. */
  stop() {
    this.beginReturn();
  }

  /** 동작 목록을 비운다. 이미 기본 자세(idle)라면 복귀 과정 없이 그대로 둔다. */
  clear() {
    this.queue = [];
    this.index = 0;
    if (this.status === "idle") {
      this.emit();
      return;
    }
    this.beginReturn();
  }

  private snapshot() {
    this.blendFrom.clear();
    for (const bone of this.controlled) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(bone as VRMHumanBoneName);
      if (node) this.blendFrom.set(bone, node.quaternion.clone());
    }
    this.blendTime = 0;
  }

  private startClip(i: number) {
    this.snapshot();
    const chained = this.queue.length > 1;
    const cur = this.queue[i];
    this.blendIn = chained ? (i === 0 ? BLEND_IN_FIRST : BLEND_IN_CHAIN) : BLEND_IN;
    this.leadIn = cur.dense ? (chained ? (i === 0 ? LEAD_IN_FIRST : LEAD_IN_CHAIN) : LEAD_IN) : 0;
    this.leading = this.leadIn > 0;
    this.range = playRange(cur, chained);
    this.index = i;
    this.time = this.range[0];
    this.status = "playing";
    this.emit();
  }

  private beginReturn() {
    this.snapshot();
    this.status = "returning";
    this.emit();
  }

  private restOf(bone: string) {
    return this.rest.get(bone) ?? this.tmp.identity();
  }

  private applyPose(target: (bone: string) => THREE.Quaternion, blend = 1) {
    for (const bone of this.controlled) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(bone as VRMHumanBoneName);
      if (!node) continue;
      const q = target(bone);
      const from = this.blendFrom.get(bone);
      if (blend < 1 && from) node.quaternion.slerpQuaternions(from, q, smooth(blend));
      else node.quaternion.copy(q);
    }
  }

  /** 매 프레임 호출. dt는 초 단위. */
  update(dt: number) {
    dt *= this.speed;
    if (this.status === "playing") {
      const cur = this.queue[this.index];
      const sampled = new THREE.Quaternion();
      this.blendTime += dt;
      if (this.leading) {
        // 리드인: 동작 시간은 멈춘 채 직전 자세 → 동작 첫 자세로 옮겨 간다
        const a = Math.min(1, this.blendTime / this.leadIn);
        this.applyPose((bone) => {
          const tr = cur.tracks.get(bone);
          return tr ? sampleTrack(tr, this.range[0], sampled, false) : this.restOf(bone);
        }, a);
        if (a >= 1) this.leading = false;
        this.emit();
        return;
      }
      this.time += dt;
      const t = Math.min(this.time, this.range[1]);
      this.applyPose((bone) => {
        const tr = cur.tracks.get(bone);
        return tr ? sampleTrack(tr, t, sampled, !cur.dense) : this.restOf(bone);
      }, this.leadIn > 0 ? 1 : Math.min(1, this.blendTime / this.blendIn));
      // AI-Hub 근사 모션은 사후 안정화만으로 관절 과굴곡/몸통 관통이 남아
      // 실제 VRM 자세 기준으로 손목 각도·손/몸통 간섭을 추가 보정한다.
      if (this.enablePoseSafety && cur.clip.motion_id.startsWith("AIHUB-SAMPLE-")) {
        this.poseSafety.correct();
      }

      if (this.time >= this.range[1]) {
        if (this.index + 1 < this.queue.length) this.startClip(this.index + 1);
        else this.beginReturn();
      } else {
        this.emit();
      }
    } else if (this.status === "returning") {
      this.blendTime += dt;
      const a = Math.min(1, this.blendTime / BLEND_OUT);
      this.applyPose((bone) => this.restOf(bone), a);
      if (a >= 1) {
        this.status = "idle";
        this.emit();
      }
    }
  }
}
