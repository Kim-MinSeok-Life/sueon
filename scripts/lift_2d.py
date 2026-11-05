#!/usr/bin/env python3
"""2D 키포인트(정면 카메라 한 대)만 있는 AI-Hub 지문자(CROWD) 데이터를 리타기팅용 3D로 복원한다.

AI 모델이 아니라 기하 계산이다.
- 뼈 길이: 실제 농인(REAL02) 3D에서 잰 비율을 쓴다(lift_ref.json).
- 손바닥: 손목·손가락 뿌리 5점을 실측 손바닥 모양에 맞춰 기울기(회전)를 구한다(정사영 가정).
  화면에 같게 보이는 기울기가 2개 나오면, 아래팔 방향과 더 자연스럽게 이어지는 쪽을 고른다.
- 손가락: 마디는 손바닥 쪽으로만 굽는다는 해부학 제약 아래, 화면에 보이는 2D 위치와 가장 맞는 굽힘 각도를 찾는다.
- 팔: 어깨→팔꿈치→손목의 화면상 길이가 실제 길이보다 짧은 만큼 카메라 쪽으로 나와 있다고 본다.
정확도는 REAL02(2D와 3D가 모두 있음)로 검증한다: python scripts/lift_2d.py validate <samples.json>
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

REF_PATH = Path(__file__).resolve().parent / 'lift_ref.json'
PALM = [0, 5, 9, 13, 17]                      # 손목 + 검지·중지·약지·소지 뿌리
FINGERS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]
THUMB = [0, 1, 2, 3, 4]
BONES = [(0, 1), (1, 2), (2, 3), (3, 4)] + [(f[i], f[i + 1]) for f in FINGERS for i in range(3)]
DEPTH_M = 2.4          # 카메라~몸통 거리(REAL02 실측 2.3~2.5m)
MIN_CONF = 0.15
TH1 = np.radians(np.arange(-20, 121, 2))     # 첫 마디 굽힘 후보
PH1 = np.radians(np.arange(-30, 31, 3))      # 첫 마디 좌우 벌림 후보
TH2 = np.radians(np.arange(-20, 201, 2))     # 다음 마디 누적 굽힘 후보
THUMB_PALM_W = 0.5                           # 엄지 두 해 고를 때 손바닥 쪽 가중치
THUMB_DZ = 0.6                               # 엄지 깊이 축소(실측 엄지는 2D 길이 변화가 깊이보다 관절 회전 탓이 큼)


def pts(arr, n):
    a = np.asarray(arr, dtype=float).reshape(n, -1)
    return a[:, :2], (a[:, 2] if a.shape[1] > 2 else np.ones(n))


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v * 0


def palm_frame(h3):
    """손바닥 좌표계(열: 손가락 방향 x, 옆 y, 법선 n)"""
    x = unit(h3[9] - h3[0])
    n = unit(np.cross(h3[5] - h3[0], h3[17] - h3[0]))
    y = np.cross(n, x)
    n = np.cross(x, y)
    return np.stack([x, y, n], axis=1)


# ---------------------------------------------------------------- 기준값(REAL02 3D에서 측정)
def build_ref(samples):
    ref = {}
    for side in ('left', 'right'):
        local, lens, tips = [], {b: [] for b in BONES}, []
        for s in samples:
            h = np.asarray(s[f'hand_{side}_keypoints_3d'], float).reshape(21, 4)
            if h[:, 3].min() < 0.3:
                continue
            h3 = h[:, :3] * s['scale']
            R = palm_frame(h3)
            loc = (h3 - h3[0]) @ R
            local.append(loc)
            for a, b in BONES:
                lens[(a, b)].append(np.linalg.norm(h3[b] - h3[a]))
        local = np.asarray(local)
        hand = float(np.median(np.linalg.norm(local[:, 9], axis=1)))
        ref[side] = {
            'palm_local': np.median(local[:, PALM], axis=0).tolist(),
            'thumb_cmc_local': np.median(local[:, 1], axis=0).tolist(),
            'bone_len': {f'{a}-{b}': float(np.median(v)) for (a, b), v in lens.items()},
            'hand_len_m': hand,
            # 손가락이 굽을 때 끝이 손바닥 법선 어느 쪽(+/-)으로 가는지
            'flex_sign': float(np.sign(np.median(local[:, [8, 12, 16, 20], 2]))),
        }
    body = []
    for s in samples:
        p = np.asarray(s['pose_keypoints_3d'], float).reshape(25, 4)[:, :3] * s['scale']
        sw = np.linalg.norm(p[2] - p[5])
        body.append([sw, np.linalg.norm(p[3] - p[2]) / sw, np.linalg.norm(p[4] - p[3]) / sw,
                     np.linalg.norm(p[6] - p[5]) / sw, np.linalg.norm(p[7] - p[6]) / sw])
    b = np.median(np.asarray(body), axis=0)
    ref['body'] = {'shoulder_m': float(b[0]), 'upper_r': float(b[1]), 'fore_r': float(b[2]),
                   'upper_l': float(b[3]), 'fore_l': float(b[4])}
    return ref


def load_ref():
    return json.loads(REF_PATH.read_text(encoding='utf-8'))


# ---------------------------------------------------------------- 손 복원
def fit_palm(obs, conf, ref, fore_dir, prev_n=None):
    """손바닥 5점의 2D(손목 기준 px)에 실측 손바닥을 맞춰 회전 R(손바닥→카메라)과 축척 s(px/m)를 구한다."""
    T = np.asarray(ref['palm_local'])          # 5x3, 손바닥 좌표(손목 원점)
    U = obs[PALM] - obs[0]
    w = np.clip(conf[PALM], 0, 1)
    if w[1:].sum() < 1.0:
        return None
    Tp = T[:, :2]
    W = np.diag(w)
    # U ≈ Tp @ A^T  (A: 2x2 = s * R[:2,:2])
    A = np.linalg.lstsq(W @ Tp, W @ U, rcond=None)[0].T
    p, q = A[0], A[1]
    pp, qq, pq = p @ p, q @ q, p @ q
    disc = max((pp + qq) ** 2 - 4 * (pp * qq - pq * pq), 0)
    s2 = ((pp + qq) + math.sqrt(disc)) / 2
    s = math.sqrt(max(s2, 1e-12))
    r1, r2 = p / s, q / s
    a = math.sqrt(max(1 - r1 @ r1, 0))
    best = None
    for sign in (1, -1):
        r13 = sign * a
        r23 = -(r1 @ r2) / r13 if abs(r13) > 1e-6 else sign * math.sqrt(max(1 - r2 @ r2, 0))
        row1 = np.array([r1[0], r1[1], r13])
        row2 = np.array([r2[0], r2[1], r23])
        row1, row2 = unit(row1), unit(row2)
        row3 = np.cross(row1, row2)
        R = np.stack([row1, row2, row3])
        # 두 해 중 손가락 방향(손목→중지 뿌리)이 아래팔 방향에 더 가까운 쪽
        d = R @ unit(T[2])
        score = d @ fore_dir if fore_dir is not None else -abs(d[2])
        if prev_n is not None:   # 촬영본 안에서는 앞 프레임 손바닥 방향과 이어지는 쪽을 더 선호(뒤집힘 떨림 방지)
            score += row3 @ prev_n
        if best is None or score > best[0]:
            best = (score, R)
    return best[1], s


def lift_hand(obs, conf, ref, fore_dir, state=None):
    """한 손 21점 2D(px) → 손목 원점 3D(px 단위, z는 카메라에서 멀어지는 방향)"""
    fit = fit_palm(obs, conf, ref, fore_dir, (state or {}).get('n'))
    if fit is None:
        return None
    R, s = fit
    if state is not None:
        state['n'] = R[:, 2]
    n = R[:, 2] * ref['flex_sign']               # 손가락이 굽는 쪽
    L = {k: v * s for k, v in ref['bone_len'].items()}
    out = np.zeros((21, 3))
    T = np.asarray(ref['palm_local'])
    for j, idx in enumerate(PALM):
        out[idx] = R @ T[j] * s
        if conf[idx] >= MIN_CONF:              # 화면 위치는 관측값을 그대로 쓴다(깊이만 모델)
            out[idx, :2] = obs[idx] - obs[0]
    for f in FINGERS:
        d0 = unit(out[f[0]] - out[0])
        d0 = unit(d0 - (d0 @ n) * n)
        e = np.cross(n, d0)
        prev_th, base = None, None
        for k in range(3):
            a, b = f[k], f[k + 1]
            Lb = L[f'{a}-{b}']
            if base is None:   # 첫 마디: 굽힘 + 좌우 벌림
                th_c, ph_c = np.meshgrid(TH1, PH1, indexing='ij')
                th_c, ph_c = th_c.ravel(), ph_c.ravel()
                d1s = np.cos(ph_c)[:, None] * d0 + np.sin(ph_c)[:, None] * e
            else:
                th_c = TH2[(TH2 >= prev_th - math.radians(10)) & (TH2 <= prev_th + math.radians(120))]
                d1s = np.repeat(base[None], len(th_c), 0)
            if conf[b] < MIN_CONF:
                th, d1 = (prev_th if prev_th is not None else math.radians(10)), (base if base is not None else d0)
            else:
                dirs = np.cos(th_c)[:, None] * d1s + np.sin(th_c)[:, None] * n
                err = np.linalg.norm(out[a, :2] + Lb * dirs[:, :2] - (obs[b] - obs[0]), axis=1)
                i = int(np.argmin(err))
                th, d1 = float(th_c[i]), d1s[i]
            out[b] = out[a] + Lb * (math.cos(th) * d1 + math.sin(th) * n)
            prev_th, base = th, d1
    # 엄지: 방향 자유. 화면 길이가 짧아진 만큼 깊이를 주고, 두 해 중 앞 마디와 덜 꺾이는 쪽
    parent = R @ unit(np.asarray(ref['thumb_cmc_local']))
    for a, b in zip(THUMB[:-1], THUMB[1:]):
        Lb = L[f'{a}-{b}']
        if conf[b] < MIN_CONF:
            out[b] = out[a] + Lb * parent
            continue
        v2 = obs[b] - obs[a]
        l = np.linalg.norm(v2)
        dz = THUMB_DZ * math.sqrt(max(Lb * Lb - l * l, 0))
        c1, c2 = np.array([v2[0], v2[1], dz]), np.array([v2[0], v2[1], -dz])
        sc = lambda c: unit(c) @ parent + THUMB_PALM_W * (unit(c) @ n)
        v = c1 if sc(c1) >= sc(c2) else c2
        out[b] = out[a] + v
        parent = unit(v)
    return out


# ---------------------------------------------------------------- 몸·팔 복원
def lift_frame(p, ref, m_per_px, center, state=None):
    """한 프레임(2D px) → AI-Hub 3D와 같은 축(미터, x 오른쪽, y 아래, z 깊이)의 body25·양손"""
    pose, pc = pts(p['pose_keypoints_2d'], 25)
    B = ref['body']
    sw_px = B['shoulder_m'] / m_per_px
    xyz = np.zeros((25, 3))
    xyz[:, :2] = pose - center
    xyz[:, 2] = 0
    xyz[[0, 15, 16], 2] = -0.08 / m_per_px     # 코·눈은 목보다 조금 앞
    xyz[[17, 18], 2] = 0.0
    hands = {}
    for side, (sh, el, wr), (ur, fr) in (('right', (2, 3, 4), (B['upper_r'], B['fore_r'])),
                                          ('left', (5, 6, 7), (B['upper_l'], B['fore_l']))):
        # 위팔은 실측상 앞뒤가 반반이라 길이를 10% 줄여 깊이를 덜 준다(REAL02 검증: 오차 8.1°→4.9°)
        for a, b, r in ((sh, el, ur * 0.9), (el, wr, fr)):
            l = np.linalg.norm(pose[b] - pose[a])
            xyz[b, 2] = xyz[a, 2] - math.sqrt(max((r * sw_px) ** 2 - l * l, 0))   # 카메라 쪽(앞)
        fore = unit(xyz[wr] - xyz[el])
        h2, hc = pts(p[f'hand_{side}_keypoints_2d'], 21)
        st = state.setdefault(side, {}) if state is not None else None
        h = lift_hand(h2, hc, ref[side], fore, st) if hc.mean() > 0.2 else None
        if h is None and st and 'h' in st:   # 손을 못 찾으면 앞 프레임 손 모양 유지
            h = st['h']
        if h is None:   # 처음부터 못 찾으면 손목에서 아래팔 방향으로 편 손
            h = np.zeros((21, 3))
            for i in range(1, 21):
                h[i] = fore * (0.02 * (1 + (i - 1) % 4) / m_per_px)
        if st is not None:
            st['h'] = h
        hands[side] = xyz[wr] + h
    to_m = lambda a: (a * m_per_px + np.array([0, 0, DEPTH_M])).tolist()
    return to_m(xyz), to_m(hands['left']), to_m(hands['right'])


def lift_take(frames2d, ref, upper_body):
    """촬영본 전체(2D 프레임 목록) → sueon-keypoints3d/v1 frames"""
    sw = []
    for p in frames2d:
        pose, pc = pts(p['pose_keypoints_2d'], 25)
        if pc[2] > 0.3 and pc[5] > 0.3:
            sw.append(np.linalg.norm(pose[2] - pose[5]))
    if not sw:
        raise ValueError('어깨를 찾지 못함')
    m_per_px = ref['body']['shoulder_m'] / float(np.median(sw))
    center = np.median([pts(p['pose_keypoints_2d'], 25)[0][1] for p in frames2d], axis=0)
    out, state = [], {}
    for i, p in frames2d_enum(frames2d):
        body, left, right = lift_frame(p, ref, m_per_px, center, state)
        r5 = lambda a: [[round(v, 5) for v in q] for q in a]
        out.append({'i': i, 'body': r5([body[j] for j in upper_body]), 'left': r5(left), 'right': r5(right)})
    return out, m_per_px


def frames2d_enum(frames2d):
    return [(p.get('_i', i), p) for i, p in enumerate(frames2d)]


# ---------------------------------------------------------------- 검증
def angle(a, b):
    return math.degrees(math.acos(float(np.clip(unit(a) @ unit(b), -1, 1))))


def validate(samples, ref):
    errs = {'finger': [], 'thumb': [], 'palm_normal': [], 'forearm': [], 'upper_arm': []}
    flat = {'finger': [], 'thumb': [], 'palm_normal': [], 'forearm': [], 'upper_arm': []}
    for s in samples:
        h3 = np.asarray(s['hand_right_keypoints_3d'], float).reshape(21, 4)
        if h3[:, 3].min() < 0.3:
            continue
        h3 = h3[:, :3]
        p3 = np.asarray(s['pose_keypoints_3d'], float).reshape(25, 4)[:, :3]
        pose2, _ = pts(s['pose_keypoints_2d'], 25)
        sw_px = np.linalg.norm(pose2[2] - pose2[5])
        m_per_px = ref['body']['shoulder_m'] / sw_px
        body, left, right = lift_frame(s, ref, m_per_px, pose2[1])
        body, right = np.asarray(body), np.asarray(right)
        h2, _ = pts(s['hand_right_keypoints_2d'], 21)
        fl = np.c_[h2, np.zeros(21)]
        for f in FINGERS:
            for a, b in zip(f[:-1], f[1:]):
                errs['finger'].append(angle(right[b] - right[a], h3[b] - h3[a]))
                flat['finger'].append(angle(fl[b] - fl[a], h3[b] - h3[a]))
        for a, b in zip(THUMB[1:-1], THUMB[2:]):
            errs['thumb'].append(angle(right[b] - right[a], h3[b] - h3[a]))
            flat['thumb'].append(angle(fl[b] - fl[a], h3[b] - h3[a]))
        n_true = palm_frame(h3)[:, 2]
        errs['palm_normal'].append(angle(palm_frame(right)[:, 2], n_true))
        flat['palm_normal'].append(angle(palm_frame(fl)[:, 2], n_true))
        errs['forearm'].append(angle(body[4] - body[3], p3[4] - p3[3]))
        errs['upper_arm'].append(angle(body[3] - body[2], p3[3] - p3[2]))
        pf = np.c_[pose2, np.zeros(25)]
        flat['forearm'].append(angle(pf[4] - pf[3], p3[4] - p3[3]))
        flat['upper_arm'].append(angle(pf[3] - pf[2], p3[3] - p3[2]))
    rep = {}
    for k in errs:
        e, f = np.asarray(errs[k]), np.asarray(flat[k])
        rep[k] = {'n': len(e), 'median_deg': round(float(np.median(e)), 1), 'p90_deg': round(float(np.percentile(e, 90)), 1),
                  'flat_2d_median_deg': round(float(np.median(f)), 1)}
    return rep


def main(argv=None):
    argv = argv or sys.argv[1:]
    cmd, path = argv[0], argv[1]
    samples = json.loads(Path(path).read_text())
    if cmd == 'build-ref':
        # 앞 절반으로 기준값을 만들고, 뒤 절반은 검증에만 쓴다(같은 데이터로 맞추고 재는 것 방지)
        takes = sorted({s['take'] for s in samples})
        train = set(takes[: len(takes) // 2])
        ref = build_ref([s for s in samples if s['take'] in train])
        ref['note'] = 'REAL02 단어 3D에서 측정한 뼈 길이·손바닥 모양(scripts/lift_2d.py build-ref)'
        REF_PATH.write_text(json.dumps(ref, ensure_ascii=False, indent=1), encoding='utf-8')
        print('기준값 저장:', REF_PATH)
    elif cmd == 'validate':
        ref = load_ref()
        takes = sorted({s['take'] for s in samples})
        test = set(takes[len(takes) // 2:])
        print(json.dumps(validate([s for s in samples if s['take'] in test], ref), ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
