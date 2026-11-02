#!/usr/bin/env python3
"""AI-Hub 수어 영상(데이터셋 103) 키포인트 ZIP/폴더 범용 파서·검증기.

- 경로 구조(중간 폴더 유무, 묶음 번호)에 의존하지 않고 파일 basename만으로
  (WORD/SEN, 번호, REAL/SYN, 촬영자 번호, 카메라 F/U/D/L/R, 프레임 번호)를 해석한다.
- 같은 촬영본(= 같은 ID + 같은 촬영자 + 같은 카메라)끼리만 프레임을 묶는다.
- 형태소(morpheme) 파일은 ID·촬영자·카메라가 모두 같을 때만 '정합'으로 판단한다.
- 원본 ZIP은 읽기만 하며, 압축을 풀거나 덮어쓰지 않는다.

이 스크립트는 일반적인 파일 파싱·통계 처리이며 AI 모델이 아니다.

사용 예:
  python scripts/aihub_keypoints.py report "[라벨]02_real_word_keypoint.zip" --ids WORD0001 WORD1502
  python scripts/aihub_keypoints.py extract "[라벨]02_real_word_keypoint.zip" --sample NIA_SL_WORD1502_REAL02 --out data/keypoints/word1502_real02.json
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

# 예: NIA_SL_WORD0001_REAL02_F_000000000012_keypoints.json / NIA_SL_SEN0001_REAL01_D_morpheme.json
NAME_RE = re.compile(
    r'NIA_SL_(?P<kind>WORD|SEN|FS)(?P<num>\d+)_(?P<actor_type>REAL|SYN|CROWD)(?P<actor>\d+)_(?P<cam>[FUDLR])'
    r'(?:_(?P<frame>\d+))?_(?P<suffix>keypoints|morpheme)\.json$'
)
VIDEO_RE = re.compile(r'NIA_SL_(?P<kind>WORD|SEN|FS)(?P<num>\d+)_(?P<actor_type>REAL|SYN|CROWD)(?P<actor>\d+)_(?P<cam>[FUDLR])\.mp4$')

# OpenPose 계열 배열 길이(값 개수). 3D는 (x,y,z,c), 2D는 (x,y,c)
EXPECTED_LEN = {
    'pose_keypoints_3d': 25 * 4, 'hand_left_keypoints_3d': 21 * 4, 'hand_right_keypoints_3d': 21 * 4,
    'face_keypoints_3d': 70 * 4, 'pose_keypoints_2d': 25 * 3, 'hand_left_keypoints_2d': 21 * 3,
    'hand_right_keypoints_2d': 21 * 3, 'face_keypoints_2d': 70 * 3,
}
KEYS_3D = ('pose_keypoints_3d', 'hand_left_keypoints_3d', 'hand_right_keypoints_3d', 'face_keypoints_3d')
# 리타기팅에 쓰는 BODY_25 상체 관절 번호: 코, 목, 오른어깨/팔꿈치/손목, 왼어깨/팔꿈치/손목, 골반 중심, 오른/왼 골반, 눈·귀
UPPER_BODY = list(range(0, 10)) + [12, 15, 16, 17, 18]


@dataclass(frozen=True)
class KeyId:
    kind: str        # WORD / SEN / FS
    num: str         # '1502'
    actor_type: str  # REAL / SYN / CROWD
    actor: str       # '02'
    cam: str         # F / U / D / L / R
    frame: int | None
    suffix: str      # keypoints / morpheme

    @property
    def item(self) -> str:
        """단어/문장 ID (예: WORD1502)"""
        return f'{self.kind}{self.num}'

    @property
    def sample(self) -> str:
        """카메라를 제외한 촬영본 ID (예: NIA_SL_WORD1502_REAL02)"""
        return f'NIA_SL_{self.item}_{self.actor_type}{self.actor}'

    @property
    def take(self) -> str:
        """카메라까지 포함한 촬영본 ID (예: NIA_SL_WORD1502_REAL02_F)"""
        return f'{self.sample}_{self.cam}'


def parse_name(path: str) -> KeyId | None:
    base = path.replace('\\', '/').rsplit('/', 1)[-1]
    m = NAME_RE.fullmatch(base)
    if not m:
        return None
    frame = m['frame']
    if (m['suffix'] == 'keypoints') != (frame is not None):
        return None  # 키포인트는 프레임 번호 필수, 형태소는 프레임 번호 없음
    return KeyId(m['kind'], m['num'], m['actor_type'], m['actor'], m['cam'],
                 int(frame) if frame is not None else None, m['suffix'])


class Source:
    """ZIP 또는 폴더를 동일하게 다루는 읽기 전용 소스"""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        if self.path.is_file() and zipfile.is_zipfile(self.path):
            self.zip = zipfile.ZipFile(self.path)
            self.names = [n for n in self.zip.namelist() if not n.endswith('/')]
        elif self.path.is_dir():
            self.zip = None
            self.names = [str(p.relative_to(self.path)).replace('\\', '/') for p in self.path.rglob('*.json')]
        else:
            raise FileNotFoundError(f'ZIP 파일 또는 폴더가 아닙니다: {self.path}')

    def read_json(self, name: str):
        data = self.zip.read(name) if self.zip else (self.path / name).read_bytes()
        return json.loads(data.decode('utf-8-sig'))


def scan(source: Source, items: set[str] | None = None, samples: set[str] | None = None):
    """촬영본(take)별 프레임 목록과 해석 불가 파일 목록을 반환한다."""
    takes: dict[str, list[tuple[int, str]]] = defaultdict(list)
    ids: dict[str, KeyId] = {}
    morphemes: dict[str, str] = {}
    unparsed: list[str] = []
    for name in source.names:
        if not name.lower().endswith('.json'):
            continue
        k = parse_name(name)
        if k is None:
            unparsed.append(name)
            continue
        if items and k.item not in items:
            continue
        if samples and k.sample not in samples:
            continue
        if k.suffix == 'morpheme':
            morphemes[k.take] = name
            continue
        takes[k.take].append((k.frame, name))
        ids.setdefault(k.take, k)
    for v in takes.values():
        v.sort()
    return takes, ids, morphemes, unparsed


def person(raw) -> dict:
    """`people`이 객체(이 데이터셋 실측)이든 리스트(OpenPose 기본)이든 첫 인물을 반환한다."""
    p = raw.get('people') if isinstance(raw, dict) else None
    if isinstance(p, list):
        if not p:
            raise ValueError('people 배열이 비어 있음')
        p = p[0]
    if not isinstance(p, dict):
        raise ValueError('people 필드가 객체/배열이 아님')
    return p


def check_frame(raw) -> list[str]:
    """한 프레임의 스키마 문제 목록(비어 있으면 정상)"""
    problems = []
    try:
        p = person(raw)
    except ValueError as e:
        return [str(e)]
    for key, n in EXPECTED_LEN.items():
        arr = p.get(key)
        if not isinstance(arr, list) or len(arr) == 0:
            problems.append(f'{key}: 없음/빈 배열')
        elif len(arr) != n:
            problems.append(f'{key}: 길이 {len(arr)} (기대 {n})')
        elif any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in arr):
            problems.append(f'{key}: 숫자가 아니거나 무한/NaN 값')
    for key in KEYS_3D:
        arr = p.get(key) or []
        if len(arr) == EXPECTED_LEN[key]:
            pts = [arr[i:i + 4] for i in range(0, len(arr), 4)]
            zero = sum(1 for q in pts if abs(q[0]) + abs(q[1]) + abs(q[2]) < 1e-9)
            if zero:
                problems.append(f'{key}: (0,0,0) 결측 관절 {zero}개')
    if not isinstance(raw.get('camparam'), dict):
        problems.append('camparam 없음')
    return problems


def points3d(arr, scale: float = 1.0) -> list[list[float]]:
    return [[arr[i] * scale, arr[i + 1] * scale, arr[i + 2] * scale] for i in range(0, len(arr), 4)]


def unit_scale(p: dict) -> tuple[str, float]:
    """3D 단위 판별. 실측: REAL02 단어 3000개 중 815개 촬영본이 mm, 나머지는 m 단위로 저장돼 있다.
    카메라~사람 거리(z)가 약 2.3~2.5이므로 몸 관절 z 중앙값이 100을 넘으면 mm로 본다."""
    zs = sorted(abs(v) for v in p['pose_keypoints_3d'][2::4])
    return ('mm', 0.001) if zs[len(zs) // 2] > 100 else ('m', 1.0)


def take_report(source: Source, frames: list[tuple[int, str]], key: KeyId, fps: float = 30.0) -> dict:
    idx = [f for f, _ in frames]
    missing = sorted(set(range(idx[0], idx[-1] + 1)) - set(idx)) if idx else []
    bad, conf_values = {}, set()
    first = last = None
    hand_jump = {'left': 0.0, 'right': 0.0}
    prev_wrist = {}
    units = set()
    for f, name in frames:
        raw = source.read_json(name)
        probs = check_frame(raw)
        if probs:
            bad[f] = probs
            continue
        p = person(raw)
        conf_values.update(p['pose_keypoints_3d'][3::4])
        unit, scale = unit_scale(p)
        units.add(unit)
        for side in ('left', 'right'):
            w = [v * scale for v in p[f'hand_{side}_keypoints_3d'][:3]]
            if side in prev_wrist:
                hand_jump[side] = max(hand_jump[side], math.dist(w, prev_wrist[side]))
            prev_wrist[side] = w
        if first is None:
            first = raw
        last = raw
    rep = {
        'take': key.take, 'item': key.item, 'actor': f'{key.actor_type}{key.actor}', 'camera': key.cam,
        'frames': len(idx), 'frame_range': [idx[0], idx[-1]] if idx else None,
        'missing_frame_indices': missing[:50], 'missing_count': len(missing),
        'duration_sec_at_fps': round(len(idx) / fps, 3), 'fps_assumed': fps,
        'bad_frames': len(bad), 'bad_examples': dict(list(bad.items())[:5]),
        'pose_confidence_values': sorted(conf_values)[:10],
        'units_detected': sorted(units),
        'max_wrist_step_m': {k: round(v, 4) for k, v in hand_jump.items()},
    }
    if first is not None:
        rep['camparam_keys'] = sorted(first['camparam'].keys())
        cm = first['camparam'].get('CameraMatrix', {}).get('data')
        rep['camera_matrix'] = cm
    return rep


def cross_camera_identical(source: Source, takes, sample: str, probe=(0,)) -> dict:
    """같은 촬영본의 카메라별 3D 배열이 동일한지(= 1회 삼각측량 결과의 중복 저장인지) 검사"""
    cams = {k.rsplit('_', 1)[1]: v for k, v in takes.items() if k.startswith(sample + '_')}
    if len(cams) < 2:
        return {'cameras': sorted(cams), 'identical_3d': None}
    out = {'cameras': sorted(cams), 'identical_3d': True}
    for i in probe:
        ref = None
        for cam, frames in sorted(cams.items()):
            if i >= len(frames):
                continue
            p = person(source.read_json(frames[i][1]))
            vec = [p[k] for k in KEYS_3D]
            if ref is None:
                ref = vec
            elif vec != ref:
                out['identical_3d'] = False
    return out


def morpheme_alignment(kp: KeyId, morpheme_path: str | Path | None, frames: int, fps: float = 30.0) -> dict:
    """키포인트 촬영본과 형태소 파일의 정합 검사. ID·촬영자·카메라가 모두 같아야 aligned=True"""
    if morpheme_path is None:
        return {'aligned': False, 'reason': '같은 촬영본의 형태소 파일 없음'}
    mk = parse_name(str(morpheme_path))
    if mk is None:
        return {'aligned': False, 'reason': '형태소 파일명 해석 불가'}
    diffs = [n for n, a, b in (('item', kp.item, mk.item), ('actor', kp.actor_type + kp.actor, mk.actor_type + mk.actor),
                               ('camera', kp.cam, mk.cam)) if a != b]
    data = json.loads(Path(morpheme_path).read_text(encoding='utf-8-sig'))
    labels = [a.get('name') for seg in data.get('data', []) for a in seg.get('attributes', [])]
    duration = data.get('metaData', {}).get('duration')
    res = {'morpheme_file': Path(morpheme_path).name, 'labels': labels, 'mismatch_fields': diffs,
           'aligned': not diffs, 'segments_sec': [[s.get('start'), s.get('end')] for s in data.get('data', [])]}
    if duration:
        res['morpheme_video_duration_sec'] = duration
        res['keypoint_duration_sec_at_fps'] = round(frames / fps, 3)
    if diffs:
        res['reason'] = ('ID 같음/촬영자·카메라 다름: 표제어는 같은 단어 ID 기준 참고만 가능, 시간 구간은 적용 불가'
                         if 'item' not in diffs else '다른 단어/문장 ID')
    return res


def extract(source: Source, frames: list[tuple[int, str]], key: KeyId, fps: float = 30.0) -> dict:
    """리타기팅용 중간 포맷(sueon-keypoints3d/v1). 상체·양손 3D만 보관(미터, F 카메라 좌표)"""
    out_frames = []
    skipped = []
    units = set()
    r4 = lambda pts: [[round(v, 5) for v in q] for q in pts]
    for f, name in frames:
        raw = source.read_json(name)
        if check_frame(raw):
            skipped.append(f)
            continue
        p = person(raw)
        unit, scale = unit_scale(p)
        units.add(unit)
        body = points3d(p['pose_keypoints_3d'], scale)
        out_frames.append({
            'i': f,
            'body': r4([body[j] for j in UPPER_BODY]),
            'left': r4(points3d(p['hand_left_keypoints_3d'], scale)),
            'right': r4(points3d(p['hand_right_keypoints_3d'], scale)),
        })
    return {
        'format': 'sueon-keypoints3d/v1',
        'take': key.take, 'item': key.item, 'actor': f'{key.actor_type}{key.actor}', 'camera': key.cam,
        'fps': fps, 'coordinate_system': 'AI-Hub 3D(미터로 정규화). F 카메라 좌표계: x=영상 오른쪽, y=아래, z=카메라에서 멀어지는 방향',
        'body_joint_ids': UPPER_BODY, 'hand_format': 'OpenPose hand 21',
        'source_units': sorted(units), 'skipped_frames': skipped, 'frames': out_frames,
        'source_note': 'AI-Hub 수어 영상(데이터셋 103) 원본 키포인트의 부분 발췌. 재배포 권한 미확인 — 공개 저장소/배포 금지.',
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('report', help='촬영본 그룹·프레임·스키마 검증 리포트')
    r.add_argument('source')
    r.add_argument('--ids', nargs='*', help='WORD0001 처럼 단어/문장 ID 제한 (생략 시 전체 그룹 요약만)')
    r.add_argument('--morphemes', default=str(Path(__file__).resolve().parents[1] / 'data/morphemes'))
    r.add_argument('--out')
    e = sub.add_parser('extract', help='한 촬영본을 sueon-keypoints3d/v1로 발췌')
    e.add_argument('source')
    e.add_argument('--sample', required=True, help='예: NIA_SL_WORD1502_REAL02')
    e.add_argument('--cam', default='F')
    e.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    src = Source(a.source)

    if a.cmd == 'report':
        items = set(a.ids) if a.ids else None
        takes, ids, morph_in_src, unparsed = scan(src, items=items)
        summary = {
            'source': src.path.name, 'json_files': len(src.names), 'unparsed_files': len(unparsed),
            'unparsed_examples': unparsed[:5], 'takes': len(takes),
            'items': len({k.item for k in ids.values()}),
            'actors': sorted({k.actor_type + k.actor for k in ids.values()}),
            'cameras': sorted({k.cam for k in ids.values()}),
        }
        details = []
        if items:
            morph_dir = Path(a.morphemes)
            local_morph = {}
            if morph_dir.is_dir():
                for p in morph_dir.glob('*_morpheme.json'):
                    k = parse_name(p.name)
                    if k:
                        local_morph.setdefault(k.item, []).append(p)
            for sample in sorted({k.sample for k in ids.values()}):
                cams = cross_camera_identical(src, takes, sample)
                for take in sorted(t for t in takes if t.startswith(sample + '_')):
                    key = ids[take]
                    rep = take_report(src, takes[take], key)
                    exact = [p for p in local_morph.get(key.item, []) if parse_name(p.name).take == take]
                    cand = exact[0] if exact else (local_morph.get(key.item) or [None])[0]
                    rep['morpheme'] = morpheme_alignment(key, cand, rep['frames'])
                    rep['cross_camera'] = cams
                    details.append(rep)
        out = {'summary': summary, 'takes': details}
        text = json.dumps(out, ensure_ascii=False, indent=2)
        if a.out:
            Path(a.out).write_text(text + '\n', encoding='utf-8')
            print(f'리포트 저장: {a.out}')
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        for d in details:
            m = d['morpheme']
            print(f"{d['take']}: {d['frames']}프레임 누락 {d['missing_count']} 불량 {d['bad_frames']} "
                  f"단위={'/'.join(d.get('units_detected', []))} 3D카메라중복={d['cross_camera']['identical_3d']} 형태소정합={m['aligned']} {m.get('labels', '')} {m.get('reason', '')}")
        return 0

    takes, ids, _, _ = scan(src, samples={a.sample})
    take = f'{a.sample}_{a.cam}'
    if take not in takes:
        print(f'촬영본을 찾지 못했습니다: {take}', file=sys.stderr)
        return 1
    data = extract(src, takes[take], ids[take])
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{take}: {len(data["frames"])}프레임 저장 → {out} (건너뜀 {len(data["skipped_frames"])})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
