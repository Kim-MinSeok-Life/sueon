import * as THREE from "three";
import type { MotionPlayer } from "./MotionPlayer";

/**
 * 개발용 원본 관절 비교 화면 (?debug=1&skeleton=1).
 *
 * scripts/retarget_vrm.py가 만든 sueon-skeleton/v1(원본 3D 키포인트를 아바타 어깨폭에 맞춰 축척)을
 * 재생 시각에 맞춰 선으로 그려 아바타 위에 겹쳐 보여 준다.
 * 리타기팅이 원본 관절 방향을 따라가는지 눈으로 비교하는 도구이며, 한국수어 정확성 판정 도구가 아니다.
 */

type P = [number, number, number];
interface SkeletonFrame { t: number; body: P[]; left: P[]; right: P[] }
interface SkeletonData { format: "sueon-skeleton/v1"; frames: SkeletonFrame[] }

// body 순서: nose, neck, rShoulder, rElbow, rWrist, lShoulder, lElbow, lWrist, midHip
const BODY_EDGES: [number, number][] = [[1, 0], [1, 2], [2, 3], [3, 4], [1, 5], [5, 6], [6, 7], [1, 8]];
// OpenPose 손 21점: 손목(0)에서 각 손가락 4마디
const HAND_EDGES: [number, number][] = [0, 1, 2, 3, 4].flatMap((f) => {
  const base = 1 + f * 4;
  return [[0, base], [base, base + 1], [base + 1, base + 2], [base + 2, base + 3]] as [number, number][];
});
const SEGMENTS = BODY_EDGES.length + HAND_EDGES.length * 2;

export class SkeletonOverlay {
  readonly object: THREE.LineSegments;
  private positions = new Float32Array(SEGMENTS * 6);
  private data: SkeletonData | null = null;
  private loadedUrl: string | null = null;
  private loading = false;
  lastFrame: SkeletonFrame | null = null;

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xff2d55, depthTest: false, transparent: true, opacity: 0.9 });
    this.object = new THREE.LineSegments(geo, mat);
    this.object.renderOrder = 10;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  private async load(url: string) {
    this.loading = true;
    this.loadedUrl = url;
    try {
      const res = await fetch(url);
      const json = (await res.json()) as SkeletonData;
      this.data = json.format === "sueon-skeleton/v1" && json.frames?.length ? json : null;
    } catch {
      this.data = null;
    } finally {
      this.loading = false;
    }
  }

  /** 매 프레임 호출: 현재 클립·재생 시각에 맞는 원본 관절 프레임을 그린다. */
  update(player: MotionPlayer | null) {
    const clip = player?.getCurrentClip();
    const state = player?.getState();
    const url = clip?.retarget?.skeleton ?? null;
    if (!url || !state || state.status === "idle" || state.status === "returning") {
      this.object.visible = false;
      return;
    }
    if (url !== this.loadedUrl && !this.loading) {
      this.data = null;
      void this.load(url);
    }
    if (!this.data) {
      this.object.visible = false;
      return;
    }
    const frames = this.data.frames;
    // 가장 가까운 원본 프레임(보간 없음: 원본 확인 목적)
    let i = 0;
    while (i + 1 < frames.length && frames[i + 1].t <= state.time) i++;
    const f = frames[i];
    this.lastFrame = f;
    let k = 0;
    const put = (a: P, b: P) => {
      this.positions.set(a, k);
      this.positions.set(b, k + 3);
      k += 6;
    };
    for (const [a, b] of BODY_EDGES) put(f.body[a], f.body[b]);
    for (const hand of [f.left, f.right]) for (const [a, b] of HAND_EDGES) put(hand[a], hand[b]);
    (this.object.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    this.object.visible = true;
  }

  dispose() {
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}
