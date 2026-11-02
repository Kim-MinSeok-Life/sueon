#!/usr/bin/env python3
"""실제 촬영 문장(REAL SEN)을 형태소(gloss) 구간으로 잘라 '수어 단어 동작 사전'을 만든다.

- 같은 촬영본(문장ID+촬영자+카메라)의 키포인트와 형태소만 사용하고, 길이 차이가 0.1초를 넘는 촬영본은 제외한다.
- gloss마다 대표 동작 1개를 고른다: 비수지(표정) 표시가 없는 구간 우선, 그 gloss 구간 길이의 중앙값에 가까운 것.
- 문장 속에서 실제로 쓰인 동작이므로 단어 단독 촬영본보다 앞뒤 연결이 자연스럽다(앞뒤 0.15초 전환 포함).
- 이 스크립트는 AI 학습이 아니라 데이터 선택·자르기·수학적 리타기팅이다. 한국수어 정확성은 별도 검수 필요.

사용 예:
  python scripts/build_gloss_library.py "수어 영상/1.Training/[라벨]02_real_sen_keypoint.zip" \\
         "수어 영상/1.Training/[라벨]01_real_sen_morpheme.zip" --actor 02
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

import aihub_keypoints as ak
import retarget_vrm as rv

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/motions/aihub_gloss'


def norm(g: str) -> str:
    return re.sub(r'\s+', '', str(g or ''))


def collect(morph_src: ak.Source, actor: str):
    """촬영자의 F카메라 문장 형태소: SEN ID → (형태소 JSON)"""
    out = {}
    for name in morph_src.names:
        k = ak.parse_name(name)
        if k and k.suffix == 'morpheme' and k.kind == 'SEN' and k.actor == actor and k.actor_type == 'REAL' and k.cam == 'F':
            out[k.take] = morph_src.read_json(name)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('keypoints', help='[라벨]NN_real_sen_keypoint.zip')
    ap.add_argument('morphemes', help='[라벨]01_real_sen_morpheme.zip')
    ap.add_argument('--actor', default='02')
    ap.add_argument('--limit', type=int, default=0, help='시험용: gloss 개수 제한')
    ap.add_argument('--pad', type=float, default=0.15, help='gloss 구간 앞뒤 여유(초)')
    a = ap.parse_args(argv)

    kp_src, mo_src = ak.Source(a.keypoints), ak.Source(a.morphemes)
    morph = collect(mo_src, a.actor)
    takes, ids, _, _ = ak.scan(kp_src)
    takes = {t: f for t, f in takes.items() if t.endswith('_F')}

    # 1) gloss별 후보 구간 모으기 (시간축이 맞는 촬영본만)
    cands = defaultdict(list)
    skipped = 0
    for take, m in morph.items():
        frames = takes.get(take)
        dur = m.get('metaData', {}).get('duration')
        if not frames or not dur or abs(len(frames) / 30 - dur) > 0.1:
            skipped += 1
            continue
        segs = sorted(m.get('data', []), key=lambda s: s['start'])
        for i, s in enumerate(segs):
            for at in s.get('attributes', []):
                g = norm(at.get('name'))
                if not g:
                    continue
                cands[g].append({'take': take, 'i': i, 'n': len(segs), 'start': s['start'], 'end': s['end'],
                                 'nonmanual': at.get('attribute') or [], 'duration': dur})

    # 2) gloss마다 대표 구간 선택
    chosen = {}
    for g, cs in cands.items():
        med = statistics.median(c['end'] - c['start'] for c in cs)
        cs.sort(key=lambda c: (bool(c['nonmanual']), abs((c['end'] - c['start']) - med), c['take']))
        chosen[g] = (cs[0], len(cs))
    names = sorted(chosen, key=lambda g: -chosen[g][1])
    if a.limit:
        names = names[:a.limit]

    # 3) 필요한 촬영본만 읽어 리타기팅 후 gloss 구간만 저장
    need = defaultdict(list)
    for g in names:
        need[chosen[g][0]['take']].append(g)
    rest, body_front = rv.load_rest(), rv.BodyFront()
    OUT.mkdir(parents=True, exist_ok=True)
    index = {}
    for n_take, (take, gl) in enumerate(sorted(need.items())):
        kp = ak.extract(kp_src, takes[take], ids[take])
        for g in gl:
            c, count = chosen[g]
            m = {'metaData': {'duration': c['duration']}, 'data': [{'start': c['start'], 'end': c['end'],
                                                                     'attributes': [{'name': g}]}]}
            frames, src, stats = rv.retarget(kp, rest, body_front=body_front, morpheme=m, pad_sec=a.pad)
            if not stats['trim'].startswith('morpheme'):
                continue
            gid = f'g{len(index) + 1:04d}'
            clip = rv.build_clip(kp, frames, stats, f'[{g}]')
            clip['motion_id'] = f"AIHUB-{kp['actor']}-GLOSS-{gid}"
            clip['label'] = f"[{g}] · {take} 문장에서 분할 (정확도 미검증)"
            clip['retarget']['source_sentence'] = take
            clip['retarget']['gloss'] = g
            (OUT / f'{gid}.json').write_text(json.dumps(clip, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            index[g] = {'id': gid, 'path': f'/motions/aihub_gloss/{gid}.json', 'source_take': take,
                        'segment_sec': [c['start'], c['end']], 'position': f"{c['i'] + 1}/{c['n']}",
                        'duration': clip['duration'], 'occurrences': count, 'nonmanual': c['nonmanual'],
                        'penetration_after_cm': stats.get('penetration_after_cm'),
                        # 같은 문장의 다른 gloss: 앱에서 이 동작이 어떤 뜻(동음이의어)인지 판단하는 데 사용
                        'context': [norm(x.get('name')) for seg in morph[take]['data'] for x in seg.get('attributes', [])
                                    if norm(x.get('name')) != g]}
        print(f'[{n_take + 1}/{len(need)}] {take}: {", ".join(gl)}', flush=True)
    meta = {
        'format': 'sueon-gloss-library/v1',
        'description': ('AI-Hub REAL 문장 3D 키포인트를 같은 촬영본 형태소 구간으로 잘라 만든 수어 단어 동작 사전. '
                        '실제 문장 속 동작(앞뒤 전환 포함). 한국수어 정확성 미검증, 재배포 권한 미확인.'),
        'actor': f'REAL{a.actor}', 'pad_sec': a.pad, 'glosses': len(index), 'skipped_misaligned_sentences': skipped,
        'items': index,
    }
    (OUT / 'index.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'완료: gloss {len(index)}개, 시간축 불일치로 제외한 문장 {skipped}개 → {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
