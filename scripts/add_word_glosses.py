#!/usr/bin/env python3
"""실제 촬영 '단어'(REAL WORD) 영상의 3D 키포인트로 수어 단어 동작을 동작 사전(aihub_gloss)에 더한다.

- 문장에서 잘라 만든 기존 동작(g0001~)은 그대로 두고, 그 목록에 없는 단어만 w0001~로 추가한다.
  (문장 속 동작이 앞뒤 연결이 더 자연스러워서 같은 단어가 있으면 문장 쪽을 우선한다)
- 고르는 기준(용량 때문에 전체 2,000여 개 중 일부만):
    1) 국립국어원 한국수어사전에 일상어로 있는 단어(뜻 분류가 있어 문장 분석기가 바로 쓸 수 있음)
    2) 사전에는 없지만 길 안내·교통 시연에 쓸 지명·교통 단어(EXTRA)
- 같은 촬영본(단어ID+촬영자+카메라)의 키포인트와 형태소만 쓰고, 길이 차이가 0.1초 넘는 촬영본은 뺀다.
- 'gloss3'처럼 번호가 붙은 변이형, 구간이 2개 이상인 촬영본은 뺀다.
- 이 스크립트는 AI 학습이 아니라 데이터 선택·자르기·수학적 리타기팅이다. 한국수어 정확성은 별도 검수 필요.

사용 예:
  python scripts/add_word_glosses.py "alhub_data/aihub_download/수어 영상/1.Training/[라벨]02_real_word_keypoint.zip" \\
         "alhub_data/aihub_download/수어 영상/1.Training/[라벨]01_real_word_morpheme.zip" --actor 02
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import aihub_keypoints as ak
import retarget_vrm as rv

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/motions/aihub_gloss'
DICT = ROOT / 'public/ksl/dictionary.json'

# 사전에 없지만 지하철·길 안내 시연에 쓸 말(AI-Hub 단어 목록에서 직접 고름)
EXTRA = """
종로3가 을지로 삼성 강서 김포 양천 관악 아차산 어린이대공원 금천 노원 노량진 홍익대학교 남부터미널 성동 왕십리
서울숲 성북 고려대학교 종합운동장 잠실 올림픽공원 신용산 이태원 남대문시장 공항시장 서울대공원 구리 남양주 성남 하남
과천 광명 군포 부천 시흥 안산 안양 안성 용인 평택 화성 동두천 양주 파주 포천 천안 에버랜드 한국민속촌
마을버스 관광버스 버스값 여객선 자가용 출근 종점 차멀미 운전자 운전면허 철교 대교 차도 찻길
죄송 피곤하다 흰 한명 두명 세명 네명 다섯명 첫번째 두번째 세번째 10만원 100만원 반드시 놀랍다 밥 안내원
""".split()


def norm(g: str) -> str:
    return re.sub(r'\s+', '', str(g or ''))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('keypoints', help='[라벨]02_real_word_keypoint.zip')
    ap.add_argument('morphemes', help='[라벨]01_real_word_morpheme.zip')
    ap.add_argument('--actor', default='02')
    ap.add_argument('--pad', type=float, default=0.15, help='단어 구간 앞뒤 여유(초)')
    ap.add_argument('--limit', type=int, default=0, help='시험용: 추가할 단어 개수 제한')
    ap.add_argument('--dry-run', action='store_true', help='고른 단어만 출력하고 파일은 만들지 않음')
    a = ap.parse_args(argv)

    meta = json.loads((OUT / 'index.json').read_text(encoding='utf-8'))
    # 다시 실행해도 같은 결과가 되도록 이전에 추가한 단어 동작(w…)은 목록에서 빼고 새로 만든다
    items = {g: v for g, v in meta['items'].items() if not v['id'].startswith('w')}
    for old in OUT.glob('w*.json'):
        if not a.dry_run:
            old.unlink()

    daily = set()
    for e in json.loads(DICT.read_text(encoding='utf-8'))['entries']:
        if e.get('d'):
            daily.update(w[0] for w in e['w'])

    kp_src, mo_src = ak.Source(a.keypoints), ak.Source(a.morphemes)
    takes, ids, _, _ = ak.scan(kp_src)
    takes = {t: f for t, f in takes.items() if t.endswith('_F')}

    # 단어 → 대표 촬영본(첫 번째로 시간축이 맞는 것)
    chosen, skipped = {}, 0
    for name in sorted(mo_src.names):
        k = ak.parse_name(name)
        if not (k and k.suffix == 'morpheme' and k.kind == 'WORD' and k.actor == a.actor and k.actor_type == 'REAL' and k.cam == 'F'):
            continue
        m = mo_src.read_json(name)
        segs = m.get('data', [])
        frames, dur = takes.get(k.take), m.get('metaData', {}).get('duration')
        if len(segs) != 1 or not frames or not dur or abs(len(frames) / 30 - dur) > 0.1:
            skipped += 1
            continue
        g = norm(segs[0]['attributes'][0].get('name') if segs[0].get('attributes') else '')
        if not g or re.search(r'\d$', g) or g in items or g in chosen:
            continue
        if g in daily or g in EXTRA:
            chosen[g] = {'take': k.take, 'm': m, 'start': segs[0]['start'], 'end': segs[0]['end'],
                         'nonmanual': segs[0]['attributes'][0].get('attribute') or [], 'kind': 'dict' if g in daily else 'extra'}
    names = sorted(chosen, key=lambda g: chosen[g]['take'])
    if a.limit:
        names = names[:a.limit]
    print(f'추가 대상 {len(names)}개(사전 {sum(chosen[g]["kind"] == "dict" for g in names)}, 시연용 {sum(chosen[g]["kind"] == "extra" for g in names)}), '
          f'시간축 불일치·구간 여러 개로 뺀 촬영본 {skipped}개', flush=True)
    if a.dry_run:
        print(' '.join(names))
        return 0

    rest, body_front = rv.load_rest(), rv.BodyFront()
    added = 0
    for n, g in enumerate(names):
        c = chosen[g]
        kp = ak.extract(kp_src, takes[c['take']], ids[c['take']])
        m = {'metaData': {'duration': c['m']['metaData']['duration']},
             'data': [{'start': c['start'], 'end': c['end'], 'attributes': [{'name': g}]}]}
        frames, _, stats = rv.retarget(kp, rest, body_front=body_front, morpheme=m, pad_sec=a.pad)
        if not stats['trim'].startswith('morpheme'):
            continue
        added += 1
        wid = f'w{added:04d}'
        clip = rv.build_clip(kp, frames, stats, f'[{g}]')
        clip['motion_id'] = f"AIHUB-{kp['actor']}-WORD-{wid}"
        clip['label'] = f"[{g}] · {c['take']} 단어 영상 (정확도 미검증)"
        clip['retarget']['source_sentence'] = c['take']
        clip['retarget']['gloss'] = g
        (OUT / f'{wid}.json').write_text(json.dumps(clip, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        items[g] = {'id': wid, 'path': f'/motions/aihub_gloss/{wid}.json', 'source_take': c['take'],
                    'segment_sec': [c['start'], c['end']], 'position': '1/1', 'duration': clip['duration'],
                    'occurrences': 1, 'nonmanual': c['nonmanual'],
                    'penetration_after_cm': stats.get('penetration_after_cm'),
                    # 단어 단독 영상이라 문장 문맥이 없다(동음이의어는 사전 기본 뜻으로)
                    'context': [], 'from': 'word'}
        if (n + 1) % 25 == 0 or n + 1 == len(names):
            print(f'[{n + 1}/{len(names)}] {g}', flush=True)

    meta['items'] = items
    meta['glosses'] = len(items)
    meta['word_glosses'] = added
    meta['description'] = ('AI-Hub REAL 문장 3D 키포인트를 같은 촬영본 형태소 구간으로 잘라 만든 수어 단어 동작(g…)과 '
                           'REAL 단어 영상 3D 키포인트로 만든 동작(w…)의 사전. 한국수어 정확성 미검증.')
    (OUT / 'index.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'완료: 단어 동작 {added}개 추가, 전체 {len(items)}개 → {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
