#!/usr/bin/env python3
"""AI-Hub 3D 키포인트(sueon-keypoints3d/v1) → VRM 정규화 본 회전(sueon-keyframes/v1) 리타기팅.

AI 학습 모델이 아니라 벡터·회전 수학(좌표계 변환, 직교 기저 정렬, 쿼터니언)으로 처리한다.

기존 import-aihub-sample.py 대비 수정점
1. 뼈 방향만 맞추던 최소 회전(from_to)이 아니라 '방향 + 보조축'으로 전체 회전을 구한다.
   - 위팔: 팔꿈치가 굽는 방향(아래팔 방향)으로 비틀림 결정
   - 아래팔·손: 검지 MCP→새끼 MCP 축(엄지 쪽 방향)으로 손바닥 방향(회내/회외) 결정
2. 손가락은 단일 Z축 굽힘이 아니라 각 마디 방향을 부모 뼈 좌표계로 옮겨 3D 회전(굽힘+벌림)을 구한다.
   엄지도 실제 엄지 축으로 계산한다.
3. 아바타의 실제 T-포즈 뼈 방향을 avatar.vrm(glTF 노드)에서 직접 읽는다(추정 상수 사용 안 함).
4. 촬영자 몸통 기준 좌표계로 정규화하고, 어깨선 회전은 upperChest에 소폭 반영한다.
5. 단위(m/mm) 정규화는 aihub_keypoints.py에서 처리한다. 30fps 전 프레임 사용 + 약한 시간 평활.

한계: 뼈 길이 비율이 달라 손의 절대 위치(얼굴·몸 접촉점)는 촬영자와 다를 수 있다(IK 미적용).
      표정·입모양(비수지)은 변환하지 않는다. 한국수어 의미 정확성은 이 스크립트로 판정할 수 없다.

사용 예:
  python scripts/retarget_vrm.py data/keypoints/word1502_real02_F.json --out-dir public/motions/aihub_real02 --compare-legacy
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import struct
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
AVATAR = ROOT / 'public/models/avatar.vrm'
BODY_FRONT = ROOT / 'data/avatar_body_front.json'  # 아바타 몸 앞면 깊이(관통 방지 기준)
LATERAL_MAX_Y = 0.98  # 이 높이보다 낮은 손만 몸 바깥쪽(옆)으로 피할 수 있음
HEAD_LATERAL_MIN_Y = 1.32  # 이 높이보다 높은 손(얼굴·머리 옆)도 옆으로 피할 수 있음(귀·옆머리 접촉 동작)
# 얼굴 근처 손 위치를 머리 비율로 다시 맞추는 범위(촬영자 기준 m): 머리 기준점에서 이 거리 안은 전부, 바깥은 서서히 몸 비율
HEAD_NEAR, HEAD_FAR = 0.14, 0.26
HEAD_CLEARANCE = 0.008  # 얼굴에 닿는 동작은 몸통(2.5cm)보다 얼굴 표면에 가깝게 둔다

# sueon-keypoints3d/v1 의 body 배열 순서(aihub_keypoints.UPPER_BODY = BODY_25 0..9,12,15..18)
B_NOSE, B_NECK, B_RSHO, B_RELB, B_RWRI, B_LSHO, B_LELB, B_LWRI, B_MIDHIP = range(9)
B_REYE, B_LEYE, B_REAR, B_LEAR = 11, 12, 13, 14

FINGERS = {  # VRM 손가락 이름 → OpenPose hand21 관절 번호(뿌리→끝)
    'Thumb': (1, 2, 3, 4), 'Index': (5, 6, 7, 8), 'Middle': (9, 10, 11, 12),
    'Ring': (13, 14, 15, 16), 'Little': (17, 18, 19, 20),
}
SEGMENTS = {'Thumb': ('Metacarpal', 'Proximal', 'Distal')}
DEFAULT_SEGMENTS = ('Proximal', 'Intermediate', 'Distal')


# ---------------------------------------------------------------- 수학 유틸
def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v * 0


def quat_from_matrix(m) -> np.ndarray:
    """회전 행렬 → [x,y,z,w]"""
    t = np.trace(m)
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def matrix_from_quat(q) -> np.ndarray:
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def from_to(a, b) -> np.ndarray:
    """a 방향을 b 방향으로 돌리는 최소 회전 행렬"""
    a, b = unit(a), unit(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -0.999999:
        axis = unit(np.cross(a, [1, 0, 0]))
        if np.linalg.norm(axis) < 0.1:
            axis = unit(np.cross(a, [0, 1, 0]))
        return 2 * np.outer(axis, axis) - np.eye(3)
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + k @ k / (1 + c)


def basis(d, s) -> np.ndarray | None:
    """주축 d, 보조축 s(직교화)로 오른손 좌표 기저 행렬. s가 d와 거의 평행하면 None"""
    d = unit(d)
    s = s - np.dot(s, d) * d
    if np.linalg.norm(s) < 1e-4:
        return None
    s = unit(s)
    return np.column_stack([d, s, np.cross(d, s)])


def align(d0, s0, d, s) -> np.ndarray | None:
    """기본자세 (d0,s0) 프레임을 목표 (d,s) 프레임으로 옮기는 회전"""
    b0, b = basis(d0, s0), basis(d, s)
    if b0 is None or b is None:
        return None
    return b @ b0.T


# ---------------------------------------------------------------- 아바타 기본자세
def load_rest(path: Path = AVATAR) -> dict[str, np.ndarray]:
    """VRM(glb)에서 휴머노이드 본의 T-포즈 월드 위치를 읽는다. 손가락 끝은 '<distal>_tip'으로 저장.
    three-vrm 정규화 본은 이 위치에 놓이고 회전 단위(identity)=T-포즈, 축은 월드 정렬이다."""
    with path.open('rb') as f:
        f.read(12)
        size, _ = struct.unpack('<I4s', f.read(8))
        gltf = json.loads(f.read(size).decode('utf-8').strip(' \0'))
    nodes = gltf['nodes']
    parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
    cache: dict[int, np.ndarray] = {}

    def world(i: int) -> np.ndarray:
        if i in cache:
            return cache[i]
        n = nodes[i]
        m = np.eye(4)
        m[:3, :3] = matrix_from_quat(n.get('rotation', [0, 0, 0, 1])) * np.array(n.get('scale', [1, 1, 1]))
        m[:3, 3] = n.get('translation', [0, 0, 0])
        cache[i] = world(parent[i]) @ m if i in parent else m
        return cache[i]

    rest = {}
    for name, b in gltf['extensions']['VRMC_vrm']['humanoid']['humanBones'].items():
        rest[name] = world(b['node'])[:3, 3].copy()
        if name.endswith('Distal'):
            kids = nodes[b['node']].get('children', [])
            if kids:
                rest[name + '_tip'] = world(kids[0])[:3, 3].copy()
    for side in ('left', 'right'):  # 끝 노드가 없는 모델 대비: 직전 마디 방향으로 연장
        for f in FINGERS:
            d = f'{side}{f}Distal'
            if d in rest and d + '_tip' not in rest:
                prev = rest[f'{side}{f}{(SEGMENTS.get(f) or DEFAULT_SEGMENTS)[1]}']
                rest[d + '_tip'] = rest[d] + (rest[d] - prev)
    return rest


# ---------------------------------------------------------------- 좌표 준비
def to_avatar_axes(p) -> np.ndarray:
    """AI-Hub F카메라 좌표(x 오른쪽, y 아래, z 깊이) → VRM 월드(x 아바타 왼쪽, y 위, z 정면).
    촬영자는 카메라를 바라보므로 촬영자 왼손(영상 오른쪽 +x)이 아바타 왼손(+X)이 된다.
    (x,-y,-z)는 X축 180° 회전으로 거울상 반전이 아니다(det=+1)."""
    p = np.asarray(p, dtype=float)
    return p * np.array([1.0, -1.0, -1.0])


def smooth(arr: np.ndarray, sigma: float) -> np.ndarray:
    """시간축 가우시안 평활(관절 떨림 완화). sigma는 프레임 단위, 0이면 미적용"""
    if sigma <= 0 or len(arr) < 3:
        return arr
    r = int(np.ceil(sigma * 2.5))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    pad = np.concatenate([np.repeat(arr[:1], r, 0), arr, np.repeat(arr[-1:], r, 0)])
    out = np.empty_like(arr)
    for i in range(len(arr)):
        out[i] = np.tensordot(k, pad[i:i + 2 * r + 1], axes=(0, 0))
    return out


def fix_hand_depth(hand: np.ndarray, cam: np.ndarray, half_width: float, torso_len: float, z_min=0.03) -> bool:
    """손목이 몸통 기둥 안쪽이면서 몸통 뒤(z<z_min)에 있는 물리적으로 불가능한 3D 깊이를 보정한다.
    실측: WORD1502_REAL02 왼손 36/105프레임이 목 기준 최대 20cm 뒤. 2D 검출은 맞고 깊이만 틀린 경우로 보고,
    손 21점 전체를 F 카메라 중심 기준으로 균일 축척해 카메라 광선을 따라 앞으로 옮긴다.
    → 영상(2D) 투영과 손 내부 뼈 방향은 그대로 유지, 손 크기만 약간 변한다. 휴리스틱 보정이다."""
    w = hand[0]
    if not (abs(w[0]) < half_width and -torso_len < w[1] < 0.02 and w[2] < z_min):
        return False
    s = (z_min - cam[2]) / (w[2] - cam[2])
    hand[:] = cam + s * (hand - cam)
    return True


def prepare(kp: dict, sigma: float):
    """프레임 배열을 아바타 축으로 바꾸고 촬영자 기준 몸통 좌표계로 정규화한다."""
    body = to_avatar_axes([f['body'] for f in kp['frames']])
    left = to_avatar_axes([f['left'] for f in kp['frames']])
    right = to_avatar_axes([f['right'] for f in kp['frames']])
    # 기준 몸통 좌표계: 전체 프레임 중앙값의 어깨선(x)·목-골반(y). 하체 키포인트는 품질이 낮아 골반 중심만 사용
    med = np.median(body, axis=0)
    x = unit(med[B_LSHO] - med[B_RSHO])
    r0 = basis(x, med[B_NECK] - med[B_MIDHIP])
    if r0 is None:
        raise ValueError('몸통 기준축을 만들 수 없습니다')
    # r0 열: 왼쪽(+X), 위(+Y), 정면(+Z)
    origin = med[B_NECK]
    tf = lambda a: (a - origin) @ r0  # 월드 → 몸통 좌표 (행벡터 기준 r0^T 적용)
    body, left, right = tf(body), tf(left), tf(right)
    cam = tf(np.zeros(3))  # F 카메라 중심(원본 좌표 원점)
    half_w = float(np.linalg.norm(med[B_LSHO] - med[B_RSHO])) / 2
    torso = float(np.linalg.norm(med[B_NECK] - med[B_MIDHIP]))
    fixed = {'left': 0, 'right': 0}
    for side, arr in (('left', left), ('right', right)):
        for i in range(len(arr)):
            fixed[side] += fix_hand_depth(arr[i], cam, half_w, torso)
    body, left, right = smooth(body, sigma), smooth(left, sigma), smooth(right, sigma)
    return body, left, right, {
        'shoulder_width_m': half_w * 2,
        'neck_to_midhip_m': torso,
        'depth_corrected_frames': fixed,
    }


# ---------------------------------------------------------------- 리타기팅
class Retargeter:
    def __init__(self, rest: dict[str, np.ndarray], chest_weight: float = 0.6,
                 ik_origin: np.ndarray | None = None, ik_scale: float = 1.0):
        """ik_origin이 주어지면 손목 '위치'를 목표로 2-본 IK를 푼다(얼굴·몸 접촉 위치 보존).
        ik_origin: 촬영자 어깨 중점(몸통 좌표), ik_scale: 아바타 어깨폭 / 촬영자 어깨폭"""
        self.rest = rest
        self.chest_weight = chest_weight
        self.prev_bend = {}
        self.ik_origin = ik_origin
        self.ik_scale = ik_scale
        self.avatar_origin = (rest['leftUpperArm'] + rest['rightUpperArm']) / 2
        self.targets: dict[str, np.ndarray] = {}
        # 프레임별 손 이동 벡터(m, 주로 +Z 전방 또는 바깥쪽 X). retarget()이 몸 앞면 간격 계산 후 매 프레임 설정
        self.forward = {'left': np.zeros(3), 'right': np.zeros(3)}
        # 프레임별 얼굴 근처 보정 벡터(m). head_offsets()가 계산해 retarget()이 매 프레임 설정
        self.head = {'left': np.zeros(3), 'right': np.zeros(3)}

    def wrist_target(self, p):
        """촬영자 몸통 좌표의 점 → 아바타 월드 좌표 (어깨 중점 기준 균일 축척)"""
        return self.avatar_origin + (p - self.ik_origin) * self.ik_scale

    def solve_arm(self, side, rc, p_sho, p_elb, p_wri):
        """2-본 IK: 손목 목표에 닿도록 팔꿈치 위치를 정하고, 팔꿈치가 굽는 면은 원본 팔꿈치 방향을 따른다."""
        up, low, hand = (self.rest[f'{side}{b}'] for b in ('UpperArm', 'LowerArm', 'Hand'))
        chest = self.rest['upperChest']
        s = chest + rc @ (up - chest)  # 어깨 관절의 현재 월드 위치(upperChest 회전 반영)
        t = self.wrist_target(p_wri) + self.head[side] + self.forward[side]
        lu, lf = np.linalg.norm(low - up), np.linalg.norm(hand - low)
        dist = float(np.clip(np.linalg.norm(t - s), abs(lu - lf) + 1e-4, lu + lf - 1e-4))
        u = unit(t - s)
        reach = unit(p_wri - p_sho)
        pole = (p_elb - p_sho) - np.dot(p_elb - p_sho, reach) * reach
        v = pole - np.dot(pole, u) * u
        if np.linalg.norm(v) < 1e-5:  # 원본 팔이 일직선이면 직전 굽힘면 사용
            v = self.prev_bend.get(side + '_ik', np.array([0, -1.0, 0]))
            v = v - np.dot(v, u) * u
        v = unit(v)
        self.prev_bend[side + '_ik'] = v
        cos_a = (lu * lu + dist * dist - lf * lf) / (2 * lu * dist)
        a = np.arccos(np.clip(cos_a, -1, 1))
        e = s + lu * (np.cos(a) * u + np.sin(a) * v)
        self.targets[side] = t
        return e - s, (s + u * dist) - e

    def rest_dir(self, a: str, b: str):
        return self.rest[b] - self.rest[a]

    def thumb_side_rest(self, side: str):
        return self.rest_dir(f'{side}LittleProximal', f'{side}IndexProximal')

    def frame(self, body, hands: dict[str, np.ndarray], base_shoulder) -> tuple[dict[str, np.ndarray], dict]:
        """한 프레임의 정규화 본 로컬 회전(행렬)과 월드 회전을 반환"""
        local, world = {}, {}
        # 1) upperChest: 기준 대비 어깨선 회전(기울기·비틀기)만 일부 반영
        cur = body[B_LSHO] - body[B_RSHO]
        rc = from_to(base_shoulder, cur)
        q = quat_from_matrix(rc)
        q = slerp(np.array([0, 0, 0, 1.0]), q, self.chest_weight)
        rc = matrix_from_quat(q)
        local['upperChest'] = rc
        world['upperChest'] = rc
        for side, (sho, elb) in (('left', (B_LSHO, B_LELB)), ('right', (B_RSHO, B_RELB))):
            h = hands[side]
            p_sho, p_elb, p_wri = body[sho], body[elb], h[0]
            parent = world['upperChest']  # shoulder(쇄골) 본은 기본자세 유지
            d_up, d_low = p_elb - p_sho, p_wri - p_elb
            if self.ik_origin is not None:
                d_up, d_low = self.solve_arm(side, rc, p_sho, p_elb, p_wri)
            # 위팔: 방향 + 팔꿈치 굽힘 방향(기본자세에서 아래팔이 굽는 쪽 = 정면 +Z)
            ru = align(self.rest_dir(f'{side}UpperArm', f'{side}LowerArm'), np.array([0, 0, 1.0]), d_up, d_low)
            if ru is None:  # 팔이 거의 펴져 굽힘면이 없으면 직전 굽힘 방향 사용
                ru = align(self.rest_dir(f'{side}UpperArm', f'{side}LowerArm'), np.array([0, 0, 1.0]), d_up,
                           self.prev_bend.get(side, np.array([0, 0, 1.0])))
            else:
                self.prev_bend[side] = d_low - np.dot(d_low, unit(d_up)) * unit(d_up)
            local[f'{side}UpperArm'] = parent.T @ ru
            world[f'{side}UpperArm'] = ru
            # 아래팔: 방향 + 엄지 쪽 축(회내/회외)
            thumb_side = h[5] - h[17]
            rl = align(self.rest_dir(f'{side}LowerArm', f'{side}Hand'), self.thumb_side_rest(side), d_low, thumb_side)
            if rl is None:
                rl = from_to(self.rest_dir(f'{side}LowerArm', f'{side}Hand'), d_low) @ ru
            local[f'{side}LowerArm'] = ru.T @ rl
            world[f'{side}LowerArm'] = rl
            # 손: 손목→중지 MCP + 엄지 쪽 축
            rh = align(self.rest_dir(f'{side}Hand', f'{side}MiddleProximal'), self.thumb_side_rest(side),
                       h[9] - h[0], thumb_side)
            if rh is None:
                rh = rl
            local[f'{side}Hand'] = rl.T @ rh
            world[f'{side}Hand'] = rh
            # 손가락: 각 마디 방향을 부모 좌표계로 옮겨 최소 회전(굽힘+벌림)
            for finger, ids in FINGERS.items():
                parent_w = rh
                segs = SEGMENTS.get(finger, DEFAULT_SEGMENTS)
                for k, seg in enumerate(segs):
                    bone = f'{side}{finger}{seg}'
                    child = f'{side}{finger}{segs[k + 1]}' if k + 1 < len(segs) else bone + '_tip'
                    target = h[ids[k + 1]] - h[ids[k]]
                    lq = from_to(self.rest_dir(bone, child), parent_w.T @ target)
                    local[bone] = lq
                    parent_w = parent_w @ lq
                    world[bone] = parent_w
        return local, world


def slerp(a, b, t):
    if np.dot(a, b) < 0:
        b = -b
    d = float(np.clip(np.dot(a, b), -1, 1))
    if d > 0.9995:
        q = a + t * (b - a)
        return q / np.linalg.norm(q)
    th = np.arccos(d)
    return (np.sin((1 - t) * th) * a + np.sin(t * th) * b) / np.sin(th)


def active_range(body, left, right, fps: float, threshold=0.08, pad_sec=0.25):
    """손이 시작 자세에서 threshold(m) 이상 움직인 구간만 남기는 휴리스틱 절단.
    형태소 시간 구간이 없는 촬영본(REAL02)용 임시 방법이며 수어 의미 구간 판정이 아니다."""
    n = len(body)
    start_pose = np.concatenate([left[:5, 0], right[:5, 0]]).reshape(2, 5, 3).mean(axis=1)
    end_pose = np.concatenate([left[-5:, 0], right[-5:, 0]]).reshape(2, 5, 3).mean(axis=1)
    disp = np.maximum(
        np.linalg.norm(np.stack([left[:, 0], right[:, 0]], 1) - start_pose, axis=2).max(1),
        0)
    disp_end = np.linalg.norm(np.stack([left[:, 0], right[:, 0]], 1) - end_pose, axis=2).max(1)
    act = np.where((disp > threshold) & (disp_end > threshold))[0]
    if len(act) == 0:
        return 0, n - 1
    pad = int(round(pad_sec * fps))
    return max(0, int(act[0]) - pad), min(n - 1, int(act[-1]) + pad)


class BodyFront:
    """아바타 몸 앞면 깊이 격자(data/avatar_body_front.json). front(x,y)=그 위치의 몸 표면 z, 없으면 -inf"""

    def __init__(self, path: Path = BODY_FRONT):
        d = json.loads(Path(path).read_text(encoding='utf-8'))
        grid = lambda g: (np.array(g['xs']), np.array(g['ys']),
                          np.array([[np.nan if v is None else v for v in row] for row in g['front_z']], dtype=float))
        self.grids = [grid(d)]
        self.head = d.get('head', {}).get('landmarks')
        if 'head' in d:  # 얼굴·머리카락 앞면(2cm 격자). 몸 격자보다 촘촘해 얼굴 앞 손 관통을 막는다
            self.grids.append(grid(d['head']))

    def front(self, x: float, y: float) -> float:
        return max(self._sample(*g, x, y) for g in self.grids)

    @staticmethod
    def _sample(xs, ys, z, x: float, y: float) -> float:
        if not (xs[0] <= x <= xs[-1] and ys[0] <= y <= ys[-1]):
            return -np.inf
        i = min(int(np.searchsorted(ys, y, side='right')) - 1, len(ys) - 2)
        j = min(int(np.searchsorted(xs, x, side='right')) - 1, len(xs) - 2)
        cell = z[i:i + 2, j:j + 2]
        ty = (y - ys[i]) / (ys[i + 1] - ys[i])
        tx = (x - xs[j]) / (xs[j + 1] - xs[j])
        # 가장 가까운 모서리에 측정면이 없으면 몸 바깥(옆구리 너머)으로 본다
        if not np.isfinite(cell[int(round(ty)), int(round(tx))]):
            return -np.inf
        w = np.array([[(1 - ty) * (1 - tx), (1 - ty) * tx], [ty * (1 - tx), ty * tx]])
        ok = np.isfinite(cell)
        return float((w * np.where(ok, cell, 0)).sum() / w[ok].sum())  # 측정된 모서리만으로 쌍선형 보간


def arm_points(local: dict, world: dict, rest: dict, side: str) -> np.ndarray:
    """순기구학: 아래팔 위 표본점(팔꿈치→손목 50/75/100%) + 손가락 마디·끝 위치"""
    chest_p = rest['upperChest']
    rc = local.get('upperChest', np.eye(3))
    up, low, hand = (rest[f'{side}{b}'] for b in ('UpperArm', 'LowerArm', 'Hand'))
    wu = rc @ local[f'{side}UpperArm']
    wl = wu @ local[f'{side}LowerArm']
    elbow = chest_p + rc @ (up - chest_p) + wu @ (low - up)
    wrist = elbow + wl @ (hand - low)
    pts = [elbow + t * (wrist - elbow) for t in (0.5, 0.75, 1.0)]
    for finger in FINGERS:
        segs = SEGMENTS.get(finger, DEFAULT_SEGMENTS)
        first = f'{side}{finger}{segs[0]}'
        p = wrist + world[f'{side}Hand'] @ (rest[first] - hand)
        pts.append(p)
        for k, seg in enumerate(segs):
            bone = f'{side}{finger}{seg}'
            child = f'{side}{finger}{segs[k + 1]}' if k + 1 < len(segs) else bone + '_tip'
            p = p + world[bone] @ (rest[child] - rest[bone])
            pts.append(p)
    return np.array(pts)


def penetration(points: np.ndarray, body_front: BodyFront) -> float:
    """몸 앞면보다 뒤(안쪽)에 있는 최대 깊이(m). 0이면 관통 없음"""
    return max(0.0, max(body_front.front(p[0], p[1]) - p[2] for p in points))


def head_offsets(body, hands: dict[str, np.ndarray], rest: dict, landmarks: dict, signer_origin, scale: float):
    """얼굴 근처 손 위치 보정(촬영자 머리 비율 → 아바타 머리 비율).
    몸 비율(어깨폭, 약 0.7배)로만 줄이면 머리가 큰 아바타에서 귀·옆머리·이마를 가리키는 손이
    볼·눈·입 앞에 떨어진다(실측: 귀 반폭 촬영자 약 8cm, 아바타 10cm / 코 돌출 7~9cm, 12cm).
    손 21점 중 머리 기준점에 가장 가까운 점이 아바타 머리의 같은 상대 위치에 오도록 손 전체를 옮기는 벡터를 돌려준다.
    머리 기준점에서 HEAD_NEAR 안은 전부 보정, HEAD_FAR 밖은 보정 없음(그 사이 부드럽게). 학습이 아닌 비율 계산이다."""
    eye = (body[:, B_REYE] + body[:, B_LEYE]) / 2
    ear = (body[:, B_REAR] + body[:, B_LEAR]) / 2
    nose = body[:, B_NOSE]
    # 머리 기준점: 좌우·앞뒤는 두 귀의 중점, 높이는 눈
    center = np.stack([ear[:, 0], eye[:, 1], ear[:, 2]], axis=1)
    ear_half = np.median(np.linalg.norm(body[:, B_LEAR] - body[:, B_REAR], axis=1)) / 2
    nose_fwd = np.median(nose[:, 2] - ear[:, 2])
    lm = landmarks
    # 높이 배율은 좌우(머리 폭) 배율과 같게 둔다. 눈-코 높이로 재면 코가 낮게 그려진 아바타에서 1.4배 이상으로 커져
    # 머리 위 동작('왜', '까먹다')이 원본보다 6cm 가량 높아짐
    kx = lm['ear_half_width'] / ear_half
    k = np.array([kx, kx, (lm['nose_tip'][2] - lm['ear_z']) / nose_fwd])
    k = np.clip(np.nan_to_num(k, nan=1.0), 0.8, 1.8)  # 키포인트 이상치 대비
    av_center = np.array([0.0, lm['eye_y'], lm['ear_z']])
    av_origin = (rest['leftUpperArm'] + rest['rightUpperArm']) / 2
    out, weight = {}, {}
    for side, h in hands.items():
        d = np.linalg.norm(h - center[:, None], axis=2)  # (프레임, 21)
        j = d.argmin(axis=1)
        q = h[np.arange(len(h)), j]
        dist = d[np.arange(len(h)), j]
        x = np.clip((dist - HEAD_NEAR) / (HEAD_FAR - HEAD_NEAR), 0, 1)
        w = 1 - x * x * (3 - 2 * x)
        body_map = av_origin + (q - signer_origin) * scale
        rel = q - center
        # 앞뒤: 얼굴 표면(코끝)까지는 얼굴 돌출 비율 k[2], 그보다 앞(얼굴에서 떨어진 손)은 머리 폭 비율 k[0]
        # (전부 k[2]로 늘리면 얼굴 앞 15cm 손이 24cm까지 멀어짐 — '시청'·'안되다'에서 확인)
        front = np.maximum(rel[:, 2] - nose_fwd, 0)
        mz = (rel[:, 2] - front) * k[2] + front * k[0]
        head_map = av_center + np.stack([rel[:, 0] * k[0], rel[:, 1] * k[1], mz], axis=1)
        out[side] = smooth(w[:, None] * (head_map - body_map), 1.5)
        weight[side] = w
    return out, weight, k


def morpheme_range(kp: dict, morpheme: dict | None, fps: float, pad_sec=0.2, max_len_diff=0.1):
    """같은 촬영본(단어ID+촬영자+카메라) 형태소의 수어 구간으로 자를 프레임 범위.
    키포인트 길이와 형태소 영상 길이 차이가 max_len_diff초를 넘으면 시간축이 어긋났다고 보고 None.
    실측: REAL02 3000개 중 751개 촬영본이 0.1초 넘게 달라 그대로 쓰면 안 됨."""
    if not morpheme or not morpheme.get('data'):
        return None
    n = len(kp['frames'])
    dur = morpheme.get('metaData', {}).get('duration')
    if not dur or abs(n / fps - dur) > max_len_diff:
        return None
    seg = morpheme['data']
    start, end = min(x['start'] for x in seg), max(x['end'] for x in seg)
    idx = [f['i'] for f in kp['frames']]
    a = max(0, int(np.searchsorted(idx, round((start - pad_sec) * fps))))
    b = min(n - 1, int(np.searchsorted(idx, round((end + pad_sec) * fps), side='right')) - 1)
    return (a, b) if b > a else None


def retarget(kp: dict, rest: dict, sigma=1.0, trim=True, chest_weight=0.6, ik=True,
             forward=0.05, clearance=0.025, body_front: BodyFront | None = None, morpheme: dict | None = None,
             pad_sec: float = 0.2, head: bool = True):
    """forward: 손 목표를 항상 앞(+Z)으로 미는 기본량(m). clearance: 몸 앞면과 최소 간격(m).
    촬영자 손 깊이를 어깨폭 비율로 줄이면 셔츠를 포함해 두꺼운 아바타 몸통(앞면 z≈0.13) 안에 손이 들어가므로
    손 목표를 카메라 쪽으로 옮겨 아래팔·손가락이 몸 앞면 + clearance 앞에 오도록 한다."""
    body, left, right, stats = prepare(kp, sigma)
    fps = float(kp.get('fps', 30))
    mr = morpheme_range(kp, morpheme, fps, pad_sec=pad_sec) if trim else None
    if mr:  # 같은 촬영본의 형태소 구간(앞뒤 0.2초 여유)
        a, b = mr
        stats['trim'] = f"morpheme {kp['take']} (앞뒤 {pad_sec:g}초 여유)"
        stats['gloss'] = [x.get('name') for seg in morpheme['data'] for x in seg.get('attributes', [])]
        # 문장(SEN)용: 클립 시작 기준 gloss별 구간(초). 연속 재생 중 현재 수어 단어 표시·분할에 사용
        t0 = kp['frames'][a]['i'] / fps
        stats['gloss_segments'] = [[x.get('name'), round(seg['start'] - t0, 3), round(seg['end'] - t0, 3)]
                                   for seg in sorted(morpheme['data'], key=lambda s: s['start']) for x in seg.get('attributes', [])]
    else:  # 형태소가 없거나 시간축이 어긋나면 손 움직임 기반 추정
        a, b = active_range(body, left, right, fps) if trim else (0, len(body) - 1)
        stats['trim'] = 'auto-motion-energy (형태소 구간 아님)' if trim else 'none'
    base_shoulder = np.median(body[:, B_LSHO] - body[:, B_RSHO], axis=0)
    origin = np.median((body[:, B_LSHO] + body[:, B_RSHO]) / 2, axis=0)
    scale = float(np.linalg.norm(rest['leftUpperArm'] - rest['rightUpperArm'])) / stats['shoulder_width_m']
    stats.update({'ik': ik, 'avatar_scale': round(scale, 4), 'signer_origin': origin})
    n = b - a + 1
    offsets = {s: np.zeros((n, 3)) for s in ('left', 'right')}
    head_off = {s: np.zeros((n, 3)) for s in ('left', 'right')}
    head_w = {s: np.zeros(n) for s in ('left', 'right')}
    # 얼굴 근처 손: 머리 비율 보정(IK와 머리 기준점이 있을 때만)
    if ik and head and body_front is not None and body_front.head:
        sl = slice(a, b + 1)
        head_off, head_w, hk = head_offsets(body[sl], {'left': left[sl], 'right': right[sl]}, rest, body_front.head,
                                        origin, scale)
        stats['head_scale'] = [round(float(v), 3) for v in hk]
        stats['head_offset_cm'] = {s: round(float(np.linalg.norm(v, axis=1).max()) * 100, 1) for s, v in head_off.items()}
        stats['head_frames'] = {s: int((v > 0.5).sum()) for s, v in head_w.items()}
    outward = {'left': 1.0, 'right': -1.0}  # 아바타 왼손은 +X, 오른손은 -X가 몸 바깥쪽

    def run():
        rt = Retargeter(rest, chest_weight, origin if ik else None, scale)
        out, prev_q = [], {}
        for k, i in enumerate(range(a, b + 1)):
            rt.forward = {s: offsets[s][k].copy() for s in offsets}
            rt.head = {s: head_off[s][k] for s in head_off}
            local, world = rt.frame(body[i], {'left': left[i], 'right': right[i]}, base_shoulder)
            bones = {}
            for name, m in local.items():
                q = quat_from_matrix(m)
                if name in prev_q and np.dot(prev_q[name], q) < 0:
                    q = -q  # 쿼터니언 부호 연속성
                prev_q[name] = q
                bones[name] = q
            out.append({'i': kp['frames'][i]['i'], 'local': local, 'world': world, 'bones': bones,
                        'targets': dict(rt.targets), 'forward': {s: rt.forward[s].tolist() for s in rt.forward},
                        'head_weight': {s: float(head_w[s][k]) for s in head_w}})
        return out

    def points(frames, s):
        return [arm_points(f['local'], f['world'], rest, s) for f in frames]

    def escape(pts, s, k):
        """현재 점들을 몸 앞면 + clearance 밖으로 빼는 추가 이동 벡터. 앞(+Z)과 바깥(±X) 중 작은 쪽 선택.
        팔을 몸 옆에 늘어뜨린 손(어깨폭 축척으로 엉덩이 앞에 들어감)은 옆으로 빼는 편이 자연스럽다."""
        pen = penetration(pts, body_front)
        if pen <= 0:
            return np.zeros(3)
        c = clearance + (HEAD_CLEARANCE - clearance) * head_w[s][k]  # 얼굴 근처일수록 표면에 가깝게
        dz = pen + c
        # 옆으로 빼기는 손목이 배꼽(약 y=0.98m) 아래인 '늘어뜨린 손'과 얼굴·머리 옆 손에만 허용, 가슴 높이는 항상 앞으로
        lateral_ok = pts[2][1] < LATERAL_MAX_Y or pts[2][1] > HEAD_LATERAL_MIN_Y  # pts[2] = 손목
        for dx in (np.arange(0.01, dz, 0.01) if lateral_ok else []):
            moved = pts + np.array([outward[s] * dx, 0, 0])
            if max(body_front.front(p[0], p[1]) - p[2] for p in moved) <= -c:
                return np.array([outward[s] * dx, 0, 0])
        return np.array([0, 0, dz])

    frames = run()
    if ik and body_front is not None:
        before = {s: np.array([penetration(p, body_front) for p in points(frames, s)]) for s in offsets}
        stats['penetration_before_cm'] = {s: round(float(v.max()) * 100, 2) for s, v in before.items()}
        for s in offsets:
            # 사용자 요청: 손·팔을 기본적으로 조금 더 앞으로. 얼굴 근처 손은 얼굴에 닿아야 하므로 빼지 않음(관통은 아래에서 별도 방지)
            offsets[s][:, 2] = forward * (1 - head_w[s])
        frames = run()
        for _ in range(4):  # 손을 옮기면 아래팔 각도도 바뀌므로 남은 관통을 반복 보정
            done = True
            for s in offsets:
                need = offsets[s] + np.array([escape(p, s, k) for k, p in enumerate(points(frames, s))])
                if np.abs(need - offsets[s]).max() > 1e-6:
                    done = False
                # 급격한 튐 방지: 성분별 최대 크기 필터(±3프레임) 후 가우시안 평활(필요량보다 작아지지 않게)
                m = np.array([need[max(0, k - 3):k + 4][np.abs(need[max(0, k - 3):k + 4]).argmax(axis=0), [0, 1, 2]]
                              for k in range(n)])
                sm = smooth(m, 2.0)
                offsets[s] = np.where(np.abs(sm) >= np.abs(need), sm, need)
            if done:
                break
            frames = run()
        after = {s: np.array([penetration(p, body_front) for p in points(frames, s)]) for s in offsets}
        stats['penetration_after_cm'] = {s: round(float(v.max()) * 100, 2) for s, v in after.items()}
        stats['forward_offset_cm'] = {s: [round(float(v[:, 2].min()) * 100, 1), round(float(v[:, 2].max()) * 100, 1)]
                                      for s, v in offsets.items()}
        stats['outward_offset_cm'] = {s: round(float(np.abs(v[:, 0]).max()) * 100, 1) for s, v in offsets.items()}
    stats.update({'trim_frames': [kp['frames'][a]['i'], kp['frames'][b]['i']], 'total_frames': len(body), 'fps': fps})
    return frames, (body[a:b + 1], left[a:b + 1], right[a:b + 1]), stats


# ---------------------------------------------------------------- 정량 검사(순기구학)
def fk_world_dirs(local: dict[str, np.ndarray], rest: dict) -> dict[str, np.ndarray]:
    """로컬 회전으로 순기구학을 돌려 주요 뼈의 월드 방향을 계산(검증용)"""
    out = {}
    chest = local.get('upperChest', np.eye(3))
    for side in ('left', 'right'):
        wu = chest @ local.get(f'{side}UpperArm', np.eye(3))
        wl = wu @ local.get(f'{side}LowerArm', np.eye(3))
        wh = wl @ local.get(f'{side}Hand', np.eye(3))
        out[f'{side}UpperArm'] = wu @ unit(rest[f'{side}LowerArm'] - rest[f'{side}UpperArm'])
        out[f'{side}LowerArm'] = wl @ unit(rest[f'{side}Hand'] - rest[f'{side}LowerArm'])
        out[f'{side}Hand'] = wh @ unit(rest[f'{side}MiddleProximal'] - rest[f'{side}Hand'])
        # 손바닥 법선 = 손 방향 × 엄지쪽 축 (좌우 동일 규칙으로 비교)
        ts = wh @ unit(rest[f'{side}IndexProximal'] - rest[f'{side}LittleProximal'])
        out[f'{side}PalmNormal'] = unit(np.cross(out[f'{side}Hand'], ts))
        for finger in FINGERS:
            w = wh
            segs = SEGMENTS.get(finger, DEFAULT_SEGMENTS)
            for k, seg in enumerate(segs):
                bone = f'{side}{finger}{seg}'
                child = f'{side}{finger}{segs[k + 1]}' if k + 1 < len(segs) else bone + '_tip'
                w = w @ local.get(bone, np.eye(3))
                out[bone] = w @ unit(rest[child] - rest[bone])
    return out


def fk_wrist(local: dict[str, np.ndarray], rest: dict, side: str) -> np.ndarray:
    """순기구학으로 아바타 손목의 월드 위치 계산(검증용)"""
    chest_p = rest['upperChest']
    rc = local.get('upperChest', np.eye(3))
    up, low, hand = (rest[f'{side}{b}'] for b in ('UpperArm', 'LowerArm', 'Hand'))
    wu = rc @ local[f'{side}UpperArm']
    wl = wu @ local[f'{side}LowerArm']
    return chest_p + rc @ (up - chest_p) + wu @ (low - up) + wl @ (hand - low)


def rest_target(rest, stats, p):
    """촬영자 몸통 좌표 → 아바타 월드 좌표(어깨 중점 기준, 어깨폭 비율 축척)"""
    origin = (rest['leftUpperArm'] + rest['rightUpperArm']) / 2
    return origin + (p - stats['signer_origin']) * stats['avatar_scale']


def source_dirs(body, left, right) -> dict[str, np.ndarray]:
    out = {}
    for side, (sho, elb), h in (('left', (B_LSHO, B_LELB), left), ('right', (B_RSHO, B_RELB), right)):
        out[f'{side}UpperArm'] = unit(body[elb] - body[sho])
        out[f'{side}LowerArm'] = unit(h[0] - body[elb])
        out[f'{side}Hand'] = unit(h[9] - h[0])
        out[f'{side}PalmNormal'] = unit(np.cross(out[f'{side}Hand'], unit(h[5] - h[17])))
        for finger, ids in FINGERS.items():
            for k, seg in enumerate(SEGMENTS.get(finger, DEFAULT_SEGMENTS)):
                out[f'{side}{finger}{seg}'] = unit(h[ids[k + 1]] - h[ids[k]])
    return out


def angle_deg(a, b):
    return float(np.degrees(np.arccos(np.clip(np.dot(unit(a), unit(b)), -1, 1))))


def error_summary(per_frame: list[dict[str, float]]) -> dict:
    groups = {'arm': ('UpperArm', 'LowerArm'), 'hand_dir': ('Hand',), 'palm_normal': ('PalmNormal',),
              'thumb': ('Thumb',), 'fingers': ('Index', 'Middle', 'Ring', 'Little')}
    res = {}
    for g, keys in groups.items():
        vals = [v for fr in per_frame for k, v in fr.items() if any(x in k for x in keys)]
        if vals:
            res[g] = {'mean_deg': round(float(np.mean(vals)), 2), 'p95_deg': round(float(np.percentile(vals, 95)), 2),
                      'max_deg': round(float(np.max(vals)), 2)}
    return res


def evaluate(frames, src, rest, stats=None) -> dict:
    body, left, right = src
    per, wrist = [], []
    for k, fr in enumerate(frames):
        fk = fk_world_dirs(fr['local'], rest)
        sd = source_dirs(body[k], left[k], right[k])
        per.append({n: angle_deg(fk[n], sd[n]) for n in sd})
        if stats is not None:
            for side, h in (('left', left[k]), ('right', right[k])):
                fwd = np.array(fr.get('forward', {}).get(side, [0.0, 0.0, 0.0]))  # 몸통 관통 방지용 이동 포함
                wrist.append(float(np.linalg.norm(fk_wrist(fr['local'], rest, side) - rest_target(rest, stats, h[0]) - fwd)))
    res = error_summary(per)
    if wrist:
        res['wrist_position_cm'] = {'mean': round(float(np.mean(wrist)) * 100, 2), 'max': round(float(np.max(wrist)) * 100, 2),
                                    'note': '어깨 중점 기준으로 축척한 원본 손목 위치와 아바타 손목 사이 거리'}
    return res


def evaluate_legacy(kp: dict, rest: dict, frame_ids: list[int]) -> dict:
    """기존 import-aihub-sample.py의 make_pose 결과를 같은 기준(카메라→아바타 축)으로 평가"""
    spec = importlib.util.spec_from_file_location('legacy_import', ROOT / 'scripts/import-aihub-sample.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    by_i = {f['i']: f for f in kp['frames']}
    ids = kp.get('body_joint_ids', list(range(15)))
    per = []
    for i in frame_ids:
        f = by_i[i]
        pose = [0.0] * 100
        for slot, j in enumerate(ids):
            pose[j * 4:j * 4 + 4] = [*f['body'][slot], 1.0]
        flat = lambda pts: [v for q in pts for v in (*q, 1.0)]
        raw = {'people': {'pose_keypoints_3d': pose, 'hand_left_keypoints_3d': flat(f['left']),
                          'hand_right_keypoints_3d': flat(f['right'])}}
        bones = mod.make_pose(raw)
        local = {k: matrix_from_quat(v) for k, v in bones.items()}
        fk = fk_world_dirs(local, rest)
        body = to_avatar_axes(f['body'])
        sd = source_dirs(body, to_avatar_axes(f['left']), to_avatar_axes(f['right']))
        per.append({n: angle_deg(fk[n], sd[n]) for n in sd})
    return error_summary(per)


# ---------------------------------------------------------------- 출력
def build_clip(kp: dict, frames, stats, label: str | None, step: int = 1, skeleton_url: str | None = None) -> dict:
    fps = stats['fps']
    t0 = frames[0]['i']
    keyframes = []
    for fr in frames[::step] if frames[-1] is frames[::step][-1] else [*frames[::step], frames[-1]]:
        keyframes.append({'t': round((fr['i'] - t0) / fps, 4),
                          'bones': {k: [round(float(x), 5) for x in q] for k, q in fr['bones'].items()}})
    item = kp['item']
    return {
        'format': 'sueon-keyframes/v1',
        'motion_id': f"AIHUB-{kp['actor']}-{item}",
        'kind': 'test',
        'label': f"{label or item} · AI-Hub {kp['take']} 3D 키포인트 리타기팅 (정확도 미검증)",
        'space': 'vrm-normalized-humanoid',
        'duration': keyframes[-1]['t'],
        'source': (f"AI-Hub 수어 영상(데이터셋 103) {kp['take']} 3D 키포인트 → scripts/retarget_vrm.py 수학적 리타기팅. "
                   '한국수어 의미·손형 정확성 미검증, 재배포 권한 미확인'),
        'keyframes': keyframes,
        'retarget': {
            'method': 'sueon-retarget/v2 (방향+보조축 정렬, 손가락 3D, 몸통 정규화)',
            'take': kp['take'], 'source_frames': stats['trim_frames'], 'source_total_frames': stats['total_frames'],
            'trim': stats['trim'], 'fps': fps,
            'depth_corrected_frames': stats['depth_corrected_frames'],
            'wrist_ik': bool(stats.get('ik')),
            **({'gloss_segments': stats['gloss_segments']} if stats.get('gloss_segments') else {}),
            **{k: stats[k] for k in ('forward_offset_cm', 'outward_offset_cm', 'penetration_before_cm', 'penetration_after_cm', 'head_scale', 'head_offset_cm', 'head_frames') if k in stats},
            **({'skeleton': skeleton_url} if skeleton_url else {}),
        },
    }


def skeleton_overlay(src, stats, rest, frame_ids, fps, offsets=None) -> dict:
    """개발용 원본 관절 비교 화면 데이터: 촬영자 몸통 좌표를 아바타 어깨폭에 맞춰 축척"""
    body, left, right = src
    scale = stats['avatar_scale']
    r = lambda a: [[round(float(v), 4) for v in rest_target(rest, stats, p)] for p in a]
    t0 = frame_ids[0]
    return {
        'format': 'sueon-skeleton/v1',
        'note': '원본 3D 키포인트(몸통 정규화·축척). 아바타 비교용, 한국수어 정확성 판정 근거 아님',
        'fps': fps, 'scale': round(scale, 4),
        'body_ids': ['nose', 'neck', 'rShoulder', 'rElbow', 'rWrist', 'lShoulder', 'lElbow', 'lWrist', 'midHip'],
        'hand_forward_note': '손(손목·손가락)은 몸통 관통 방지용 이동 벡터(fwd, m)를 반영해 그림. 팔꿈치·어깨는 원본 위치',
        'frames': [_skel_frame(r, body[k], left[k], right[k], (frame_ids[k] - t0) / fps,
                               offsets[k] if offsets else {'left': [0.0] * 3, 'right': [0.0] * 3})
                   for k in range(len(frame_ids))],
    }


def load_morphemes(src: str, takes: set[str]) -> dict[str, dict]:
    """필요한 촬영본의 형태소만 읽는다(폴더 또는 ZIP, 압축 해제 없음)."""
    from aihub_keypoints import Source, parse_name
    out = {}
    if not src or not Path(src).exists():
        return out
    source = Source(src)
    for name in source.names:
        k = parse_name(name)
        if k and k.suffix == 'morpheme' and k.take in takes:
            out[k.take] = source.read_json(name)
    return out


def _skel_frame(r, body, left, right, t, fwd):
    shift = lambda pts, side: [[round(x + fwd[side][0], 4), y, round(z + fwd[side][2], 4)] for x, y, z in pts]
    b = r(body[:9])
    b[B_LWRI] = shift([b[B_LWRI]], 'left')[0]
    b[B_RWRI] = shift([b[B_RWRI]], 'right')[0]
    return {'t': round(t, 4), 'body': b, 'left': shift(r(left), 'left'), 'right': shift(r(right), 'right'),
            'fwd': [[round(v, 4) for v in fwd['left']], [round(v, 4) for v in fwd['right']]]}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('inputs', nargs='+', help='sueon-keypoints3d/v1 JSON 파일')
    ap.add_argument('--out-dir', default=str(ROOT / 'public/motions/aihub_real02'))
    ap.add_argument('--labels', default=str(ROOT / 'data/aihub_morphemes.json'), help='단어 ID 표제어 색인')
    ap.add_argument('--sigma', type=float, default=1.0, help='시간 평활 가우시안 sigma(프레임)')
    ap.add_argument('--no-trim', action='store_true')
    ap.add_argument('--no-ik', action='store_true', help='손목 위치 IK 끄기(관절 방향만 복사)')
    ap.add_argument('--forward', type=float, default=0.05, help='손을 항상 앞으로 미는 기본량(m)')
    ap.add_argument('--clearance', type=float, default=0.025, help='몸 앞면과 아래팔·손가락의 최소 간격(m)')
    ap.add_argument('--morphemes', default=str(ROOT / 'data/morphemes'),
                    help='형태소 폴더 또는 AI-Hub morpheme ZIP. 같은 촬영본 형태소가 있으면 그 구간으로 자름')
    ap.add_argument('--step', type=int, default=1, help='키프레임 간격(1=30fps 전 프레임)')
    ap.add_argument('--compare-legacy', action='store_true', help='기존 변환식과 정량 비교')
    ap.add_argument('--report', default=str(ROOT / 'reports/retarget_report.json'))
    a = ap.parse_args(argv)

    rest = load_rest()
    body_front = BodyFront()
    morphemes = load_morphemes(a.morphemes, {json.loads(Path(p).read_text(encoding='utf-8'))['take'] for p in a.inputs})
    labels = {}
    if Path(a.labels).exists():
        labels = {i['word_id']: i['korean'] for i in json.loads(Path(a.labels).read_text(encoding='utf-8'))['items']}
    out_dir = Path(a.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {}
    for path in a.inputs:
        kp = json.loads(Path(path).read_text(encoding='utf-8'))
        if kp.get('format') != 'sueon-keypoints3d/v1':
            print(f'건너뜀(형식 아님): {path}', file=sys.stderr)
            continue
        morph = morphemes.get(kp['take'])
        frames, src, stats = retarget(kp, rest, sigma=a.sigma, trim=not a.no_trim, ik=not a.no_ik,
                                      forward=a.forward, clearance=a.clearance, body_front=body_front, morpheme=morph)
        name = f"{kp['item'].lower()}_{kp['actor'].lower()}"
        url = f"/motions/{out_dir.name}/{name}.skeleton.json" if out_dir.parent.name == 'motions' else None
        # 문장은 한국어 원문이 없어 수어 gloss 순서를 라벨로 사용(한국어 번역 아님)
        label = labels.get(kp['item']) or (f"[{' '.join(stats['gloss'])}]" if stats.get('gloss') else None)
        clip = build_clip(kp, frames, stats, label, a.step, url)
        (out_dir / f'{name}.json').write_text(json.dumps(clip, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        ids = [fr['i'] for fr in frames]
        skel = skeleton_overlay(src, stats, rest, ids, stats['fps'], [fr['forward'] for fr in frames])
        (out_dir / f'{name}.skeleton.json').write_text(json.dumps(skel, separators=(',', ':')), encoding='utf-8')
        rep = {'clip': f'{out_dir.name}/{name}.json', 'label_from_other_actor': labels.get(kp['item']),
               'frames': len(frames), 'duration_sec': clip['duration'],
               **{k: v for k, v in stats.items() if k != 'signer_origin'},
               'retarget_error_v2': evaluate(frames, src, rest, stats)}
        # 비교: IK 없이 관절 방향만 복사했을 때(손목 위치 오차가 커짐)
        f0, s0, st0 = retarget(kp, rest, sigma=a.sigma, trim=not a.no_trim, ik=False)
        rep['retarget_error_direction_only'] = evaluate(f0, s0, rest, st0)
        if a.compare_legacy:
            rep['retarget_error_legacy'] = evaluate_legacy(kp, rest, ids)
        report[kp['take']] = rep
        v2 = rep['retarget_error_v2']
        wr = (v2['wrist_position_cm']['mean'], rep['retarget_error_direction_only']['wrist_position_cm']['mean'])
        line = (f"{kp['take']}: {len(frames)}프레임 {clip['duration']}s 깊이보정 {stats['depth_corrected_frames']} "
                f"손목위치오차 {'IK' if stats['ik'] else '방향복사'} {wr[0]}cm / 방향복사 {wr[1]}cm · "
                f"손바닥법선 v2 {v2['palm_normal']['mean_deg']}° · 몸통관통(cm) 전 {stats.get('penetration_before_cm')} "
                f"→ 후 {stats.get('penetration_after_cm')} 전방(cm) {stats.get('forward_offset_cm')} 바깥(cm) {stats.get('outward_offset_cm')}")
        if a.compare_legacy:
            lg = rep['retarget_error_legacy']
            line += (f" / 기존 {lg['palm_normal']['mean_deg']}° · 손가락 v2 {v2['fingers']['mean_deg']}° / 기존 "
                     f"{lg['fingers']['mean_deg']}° · 엄지 v2 {v2['thumb']['mean_deg']}° / 기존 {lg['thumb']['mean_deg']}°")
        print(line)
    if a.report:
        Path(a.report).parent.mkdir(parents=True, exist_ok=True)
        Path(a.report).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'리포트: {a.report}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
