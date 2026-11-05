#!/usr/bin/env python3
"""AI-Hub 지문자(CROWD, 2D 키포인트만 있음) 영상으로 숫자·역 이름 동작을 동작 사전(aihub_gloss)에 더한다.

- 지문자 데이터에는 3D 좌표가 비어 있어 scripts/lift_2d.py로 2D → 3D를 기하 계산으로 복원한 뒤,
  기존과 같은 scripts/retarget_vrm.py로 아바타에 옮긴다(AI 학습·생성 아님).
- 대상: 숫자·숫자+단위(1호선, 10분, 3시 …)와 역·명소 이름. 도로명(…로, …길)은 용량 때문에 뺀다.
- 실제 농인 동작(g…, w…)이 이미 있는 단어는 그대로 두고 f0001~로 추가만 한다. 다시 실행해도 같은 결과.
- 같은 단어를 여러 사람이 찍었으면, 키포인트·형태소 길이가 맞는 촬영본 중 손 검출 신뢰도가 가장 높은 것을 쓴다.
- 일반인(지문자 데이터 촬영자)의 동작이고 2D에서 깊이를 추정했으므로 손 모양 정확도는 실제 농인 3D보다 낮다.

사용 예:
  python scripts/add_fingerspell_glosses.py "alhub_data/수어 영상/1.Training/[라벨]01_crowd_keypoint.zip" \\
         "alhub_data/수어 영상/1.Training/[라벨]01_crowd_morpheme.zip"
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

import aihub_keypoints as ak
import lift_2d
import retarget_vrm as rv

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/motions/aihub_gloss'
ROAD = re.compile(r'(로|길)(\d+(번)?길)?$')


def norm(g: str) -> str:
    return re.sub(r'\s+', '', str(g or ''))


def hand_conf(p: dict) -> float:
    """두 손 중 더 잘 잡힌 손의 평균 신뢰도(지문자는 한 손으로 함)"""
    return max(float(np.mean(p[f'hand_{s}_keypoints_2d'][2::3])) for s in ('left', 'right'))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('keypoints', help='[라벨]01_crowd_keypoint.zip')
    ap.add_argument('morphemes', help='[라벨]01_crowd_morpheme.zip')
    ap.add_argument('--pad', type=float, default=0.15, help='지문자 구간 앞뒤 여유(초)')
    ap.add_argument('--candidates', type=int, default=4, help='단어마다 비교할 촬영본 수')
    ap.add_argument('--limit', type=int, default=0, help='시험용: 추가할 단어 개수 제한')
    ap.add_argument('--only', nargs='*', help='시험용: 이 단어만')
    ap.add_argument('--dry-run', action='store_true', help='고른 단어만 출력하고 파일은 만들지 않음')
    a = ap.parse_args(argv)

    meta = json.loads((OUT / 'index.json').read_text(encoding='utf-8'))
    items = {g: v for g, v in meta['items'].items() if not v['id'].startswith('f')}
    if not a.dry_run:
        for old in OUT.glob('f*.json'):
            old.unlink()

    mo_src = ak.Source(a.morphemes)
    by_word: dict[str, list] = defaultdict(list)
    for name in mo_src.names:
        k = ak.parse_name(name)
        if not (k and k.suffix == 'morpheme' and k.kind == 'FS' and k.cam == 'F'):
            continue
        m = mo_src.read_json(name)
        segs = m.get('data', [])
        if len(segs) != 1 or not segs[0].get('attributes'):
            continue
        g = norm(segs[0]['attributes'][0].get('name'))
        if g and not ROAD.search(g) and g not in items:
            by_word[g].append((k.take, m))
    words = sorted(by_word)
    if a.only:
        words = [w for w in words if w in a.only]
    if a.limit:
        words = words[:a.limit]
    print(f'추가 대상 {len(words)}개(숫자 포함 {sum(bool(re.search(r"[0-9]", w)) for w in words)}개)', flush=True)
    if a.dry_run:
        print(' '.join(words))
        return 0

    print('키포인트 파일 목록 읽는 중…', flush=True)
    kp_src = ak.Source(a.keypoints)
    takes, ids, _, _ = ak.scan(kp_src)
    ref = lift_2d.load_ref()
    rest, body_front = rv.load_rest(), rv.BodyFront()
    added, failed = 0, []
    for n, g in enumerate(words):
        # 시간축이 맞는 촬영본 중 손 검출이 가장 좋은 것
        best, tried = None, 0
        for take, m in sorted(by_word[g]):
            if tried >= a.candidates:
                break
            frames = takes.get(take)
            dur = m.get('metaData', {}).get('duration')
            if not frames or not dur or abs(len(frames) / 30 - dur) > 0.1:
                continue
            seg = m['data'][0]
            inside = [nm for f, nm in frames if seg['start'] * 30 <= f <= seg['end'] * 30][::4]
            if not inside:
                continue
            tried += 1
            score = float(np.mean([hand_conf(ak.person(kp_src.read_json(nm))) for nm in inside]))
            if best is None or score > best[0]:
                best = (score, take, m)
        if best is None:
            failed.append(g)
            continue
        score, take, m = best
        raw = []
        for f, nm in takes[take]:
            p = ak.person(kp_src.read_json(nm))
            p['_i'] = f
            raw.append(p)
        try:
            lifted, _ = lift_2d.lift_take(raw, ref, ak.UPPER_BODY)
        except ValueError:
            failed.append(g)
            continue
        key = ids[take]
        kp = {'format': 'sueon-keypoints3d/v1', 'take': take, 'item': key.item, 'actor': f'{key.actor_type}{key.actor}',
              'camera': key.cam, 'fps': 30.0, 'frames': lifted}
        seg = m['data'][0]
        mm = {'metaData': {'duration': m['metaData']['duration']},
              'data': [{'start': seg['start'], 'end': seg['end'], 'attributes': [{'name': g}]}]}
        frames, _, stats = rv.retarget(kp, rest, sigma=1.5, body_front=body_front, morpheme=mm, pad_sec=a.pad)
        if not stats['trim'].startswith('morpheme'):
            failed.append(g)
            continue
        added += 1
        fid = f'f{added:04d}'
        clip = rv.build_clip(kp, frames, stats, f'[{g}]', step=2)   # 15fps 키프레임(용량 절반, 재생 시 보간)
        clip['motion_id'] = f"AIHUB-{kp['actor']}-FS-{fid}"
        clip['label'] = f"[{g}] · {take} 지문자 영상 2D→3D 복원 (정확도 미검증)"
        clip['source'] = (f'AI-Hub 수어 영상(데이터셋 103) 지문자 {take} 2D 키포인트 → scripts/lift_2d.py 기하 복원 → '
                          'scripts/retarget_vrm.py 수학적 리타기팅. 일반인 촬영, 손 모양 정확성 미검증')
        clip['retarget']['source_sentence'] = take
        clip['retarget']['gloss'] = g
        clip['retarget']['lift'] = '2d-geometric (scripts/lift_2d.py)'
        (OUT / f'{fid}.json').write_text(json.dumps(clip, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        items[g] = {'id': fid, 'path': f'/motions/aihub_gloss/{fid}.json', 'source_take': take,
                    'segment_sec': [seg['start'], seg['end']], 'position': '1/1', 'duration': clip['duration'],
                    'occurrences': 1, 'nonmanual': [], 'hand_confidence': round(score, 3),
                    'penetration_after_cm': stats.get('penetration_after_cm'),
                    'context': [], 'from': 'fingerspell'}
        if (n + 1) % 20 == 0 or n + 1 == len(words):
            print(f'[{n + 1}/{len(words)}] {g} (손 신뢰도 {score:.2f})', flush=True)

    meta['items'] = items
    meta['glosses'] = len(items)
    meta['fingerspell_glosses'] = added
    meta['description'] = ('AI-Hub REAL 문장 3D 키포인트를 같은 촬영본 형태소 구간으로 잘라 만든 수어 단어 동작(g…), '
                           'REAL 단어 영상 3D 키포인트로 만든 동작(w…), 지문자 영상 2D 키포인트를 3D로 복원해 만든 '
                           '숫자·역 이름 동작(f…)의 사전. 한국수어 정확성 미검증.')
    (OUT / 'index.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'완료: 지문자 동작 {added}개 추가, 실패 {len(failed)}개 {failed[:20]}, 전체 {len(items)}개 → {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
