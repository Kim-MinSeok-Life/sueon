"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import { MotionPlayer } from "@/lib/MotionPlayer";
import { SkeletonOverlay } from "@/lib/SkeletonOverlay";

const AVATAR_URL = "/models/avatar.vrm";

export type StageStatus =
  | { kind: "loading"; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

interface Props {
  onPlayer: (player: MotionPlayer | null) => void;
  onStatus: (status: StageStatus) => void;
  children?: React.ReactNode;
  viewMode?: "upper" | "hands";
  /** 재생 중에 얹을 VRM 표정(비수지 근사). null이면 무표정 */
  expression?: StageExpression | null;
}

/**
 * 비수지 표정 근사(규칙, 미검증): 아바타에 눈썹 전용 표정이 없어 VRM 기본 표정을 약하게 섞는다.
 * 예/아니요 의문 → surprised(눈썹 올림), 의문사 의문 → angry(눈썹 모음). 얼굴 키포인트에서 옮긴 값이 아니다.
 */
export interface StageExpression { name: "surprised" | "angry"; weight: number }
export const QUESTION_EXPRESSION: Record<"yesno" | "wh", StageExpression> = {
  yesno: { name: "surprised", weight: 0.45 },
  wh: { name: "angry", weight: 0.35 },
};
const EXPRESSION_RATE = 3; // 초당 표정 변화량(약 0.15초 만에 들어오고 빠짐)

declare global {
  interface Window {
    __SUEON__?: Record<string, unknown>;
  }
}

/** 개발·자동 테스트용 훅. ?debug=1 일 때만 설치된다. */
function installDebugHook(vrm: VRM, player: MotionPlayer, skeleton: SkeletonOverlay | null) {
  const euler = new THREE.Euler();
  window.__SUEON__ = {
    ready: true,
    fingerBones: Object.keys(vrm.humanoid.humanBones).filter((b) =>
      /Thumb|Index|Middle|Ring|Little/.test(b),
    ),
    /** 실제 스킨 본(raw)의 월드 회전. 정규화 본에 쓴 값이 실제 메시에 전달됐는지 확인용 */
    rawWorldQuat(bone: VRMHumanBoneName) {
      const node = vrm.humanoid.getRawBoneNode(bone);
      if (!node) return null;
      node.updateWorldMatrix(true, false);
      const q = new THREE.Quaternion();
      node.getWorldQuaternion(q);
      return q.toArray();
    },
    /** 관절 각도를 직접 지정 (도 단위 XYZ). 포즈 제작 확인용 */
    setPoseDeg(pose: Record<string, [number, number, number]>) {
      for (const [bone, [x, y, z]] of Object.entries(pose)) {
        const node = vrm.humanoid.getNormalizedBoneNode(bone as VRMHumanBoneName);
        node?.quaternion.setFromEuler(euler.set((x * Math.PI) / 180, (y * Math.PI) / 180, (z * Math.PI) / 180));
      }
    },
    playerState: () => player.getState(),
    seek: (t: number) => player.seek(t),
    currentClip: () => player.getCurrentClip(),
    poseSafetyStats: () => player.getPoseSafetyStats(),
    setPoseSafetyEnabled: (value: boolean) => player.setPoseSafetyEnabled(value),
    /** 정규화 본의 월드 위치. 원본 관절(skeletonFrame)과 방향 비교용 */
    bonePositions(bones: VRMHumanBoneName[]) {
      const v = new THREE.Vector3();
      return Object.fromEntries(bones.map((b) => {
        const node = vrm.humanoid.getNormalizedBoneNode(b);
        if (!node) return [b, null];
        node.updateWorldMatrix(true, false);
        return [b, node.getWorldPosition(v).toArray()];
      }));
    },
    /** 정면(+Z)에서 -Z로 광선을 쏴 몸 표면 깊이를 잰다. 몸통 앞면 측정용 */
    raycastFront(x: number, y: number) {
      vrm.scene.updateMatrixWorld(true);
      const ray = new THREE.Raycaster(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1));
      return ray.intersectObject(vrm.scene, true).map((h) => ({
        z: h.point.z,
        mesh: h.object.name,
        material: (Array.isArray((h.object as THREE.Mesh).material) ? "" : ((h.object as THREE.Mesh).material as THREE.Material).name),
      }));
    },
    /** VRM 표정 값 지정(0~1). 비수지 표정 근사 확인용 */
    setExpression(name: string, weight: number) { vrm.expressionManager?.setValue(name, weight); },
    /** 마지막으로 그린 원본 관절 프레임 (?skeleton=1) */
    skeletonFrame: () => skeleton?.lastFrame ?? null,
  };
}

export default function AvatarStage({ onPlayer, onStatus, viewMode = "upper", expression = null, children }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const viewModeRef = useRef(viewMode);
  const resizeRef = useRef<(() => void) | null>(null);
  const expressionRef = useRef(expression);
  useEffect(() => { expressionRef.current = expression; }, [expression]);
  useEffect(() => {
    viewModeRef.current = viewMode;
    resizeRef.current?.();
  }, [viewMode]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let raf = 0;
    let vrm: VRM | null = null;
    let player: MotionPlayer | null = null;
    const params = new URLSearchParams(window.location.search);
    // ?debug=1&skeleton=1: 원본 3D 키포인트를 아바타 위에 겹쳐 그리는 개발용 비교 화면
    const skeleton = process.env.NODE_ENV !== "production" && params.has("debug") && params.get("skeleton") === "1"
      ? new SkeletonOverlay() : null;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    } catch {
      const msg = "이 브라우저에서 3D 화면(WebGL)을 사용할 수 없습니다. 하드웨어 가속을 켜거나 다른 브라우저를 사용해 주세요.";
      setFailed(msg);
      onStatus({ kind: "error", message: msg });
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.innerWidth < 720 ? 1.5 : 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // 원래 VRM 모델은 유지하되, 손형을 읽기 쉬운 상반신 구도로 촬영한다.
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
    camera.position.set(0, 1.3, 2.2);
    camera.lookAt(0, 1.26, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a94a6, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.6, 1.8, 2.2);
    scene.add(key);
    if (skeleton) scene.add(skeleton.object);

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h, false);
      if (!w || !h) return;
      camera.aspect = w / h;
      // 세로 화면에서는 전신 대신 상반신을 보여 주고, 손 확대는 사용자에게 선택권을 준다.
      const narrow = w < 500;
      const middle = w >= 500 && w < 800;
      const close = viewModeRef.current === "hands";
      camera.position.z = narrow ? (close ? 1.95 : 2.4) : middle ? (close ? 1.75 : 2.2) : (close ? 1.55 : 1.95);
      const focusY = close ? 1.28 : 1.27;
      camera.position.y = focusY + 0.04;
      camera.lookAt(0, focusY, 0);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resizeRef.current = resize;
    resize();

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    onStatus({ kind: "loading", progress: 0 });

    loader.load(
      AVATAR_URL,
      (gltf) => {
        if (disposed) return;
        const loaded = gltf.userData.vrm as VRM | undefined;
        if (!loaded) {
          const msg = "아바타 파일에서 VRM 정보를 찾지 못했습니다.";
          setFailed(msg);
          onStatus({ kind: "error", message: msg });
          return;
        }
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        loaded.scene.traverse((o) => (o.frustumCulled = false));
        vrm = loaded;
        scene.add(vrm.scene);

        player = new MotionPlayer(vrm);
        // ?poseSafety=0: 개발 환경에서 원본과 보정 결과를 비교하기 위한 옵션.
        if (process.env.NODE_ENV !== "production" &&
            new URLSearchParams(window.location.search).get("poseSafety") === "0") {
          player.setPoseSafetyEnabled(false);
        }
        if (process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).has("debug")) installDebugHook(vrm, player, skeleton);
        onPlayer(player);
        onStatus({ kind: "ready" });
      },
      (ev) => {
        if (ev.total) onStatus({ kind: "loading", progress: ev.loaded / ev.total });
      },
      (err) => {
        const msg = `아바타를 불러오지 못했습니다: ${err instanceof Error ? err.message : String(err)}`;
        setFailed(msg);
        onStatus({ kind: "error", message: msg });
      },
    );

    const clock = new THREE.Clock();
    // 표정 가중치: 재생(일시정지 포함) 중에만 목표값으로, 끝나면 0으로 서서히
    const faceWeights: Record<string, number> = { surprised: 0, angry: 0 };
    const updateFace = (dt: number) => {
      const em = vrm?.expressionManager;
      if (!em || !player) return;
      const status = player.getState().status;
      const want = expressionRef.current && (status === "playing" || status === "paused") ? expressionRef.current : null;
      for (const name of Object.keys(faceWeights)) {
        const target = want?.name === name ? want.weight : 0;
        const cur = faceWeights[name];
        const step = EXPRESSION_RATE * dt;
        const next = Math.abs(target - cur) <= step ? target : cur + Math.sign(target - cur) * step;
        if (next !== cur) { faceWeights[name] = next; em.setValue(name, next); }
      }
    };
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = clock.getDelta();
      // 저사양 기기에서도 재생 시각은 실제 프레임 간격을 따른다.
      // 물리 갱신의 급격한 도약만 제한한다.
      if (document.visibilityState === "visible") {
        player?.update(dt);
        updateFace(Math.min(dt, 0.05));
        vrm?.update(Math.min(dt, 0.05));
        skeleton?.update(player);
      }
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      resizeRef.current = null;
      onPlayer(null);
      if (vrm) VRMUtils.deepDispose(vrm.scene);
      skeleton?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      delete window.__SUEON__;
    };
    // onPlayer/onStatus는 부모에서 안정된 함수로 전달된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="stage">
      <div ref={mountRef} className="stage-canvas" aria-label="수어 아바타 3D 화면" role="img" />
      {failed && <p className="stage-error">{failed}</p>}
      {children}
    </div>
  );
}
