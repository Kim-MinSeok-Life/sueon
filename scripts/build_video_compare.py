#!/usr/bin/env python3
"""원본 영상 ↔ 아바타 비교표 만들기 (개발·검수용).

수어 단어 동작마다 "어느 영상 ZIP의 어느 파일, 몇 초 구간"을 보면 되는지 찾아 data/video_compare.json에 적는다.
- 같은 촬영자(REAL02) 영상이 있으면 그것을 쓴다 → 아바타와 같은 사람·같은 시간축이라 1:1 비교 가능.
- 없으면 같은 문장을 다른 촬영자가 한 영상(예: REAL01)을 쓴다 → "같은 수어 단어인가" 확인용(동작 타이밍은 다름).
- 영상은 복사하지 않는다. 무압축(stored) ZIP 안의 바이트 위치만 기록하고, 개발 서버가 그 위치를 바로 읽어 보낸다.
- AI 학습이 아니라 파일 이름·형태소 라벨을 대조하는 일반 스크립트다.

사용 예(인자 없이 실행하면 alhub_data/ 아래 ZIP을 자동으로 찾음):
  python scripts/build_video_compare.py
  python scripts/build_video_compare.py --root D:\\aihub
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data/video_compare.json'
TAKE_RE = re.compile(r'(NIA_SL_(SEN|WORD)(\d{4})_(REAL\d{2})_([FUDLR]))')


def norm(g) -> str:
    return re.sub(r'\s+', '', str(g or ''))


def data_offset(zpath: Path, info: zipfile.ZipInfo) -> int:
    """ZIP 로컬 헤더 뒤 실제 파일 데이터가 시작하는 바이트 위치"""
    with open(zpath, 'rb') as f:
        f.seek(info.header_offset)
        head = f.read(30)
    if head[:4] != b'PK\x03\x04':
        raise ValueError(f'로컬 헤더가 아닙니다: {info.filename}')
    name_len, extra_len = struct.unpack('<HH', head[26:30])
    return info.header_offset + 30 + name_len + extra_len


def rel(p: Path) -> str:
    try:
        return p.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(p.resolve())


def scan_videos(zips):
    """take → 영상 위치. 압축된 항목은 바로 읽어 보낼 수 없어 제외한다."""
    out, compressed = {}, 0
    for zp in zips:
        with zipfile.ZipFile(zp) as z:
            for info in z.infolist():
                m = TAKE_RE.search(info.filename)
                if not m or not info.filename.endswith('.mp4'):
                    continue
                if info.compress_type != zipfile.ZIP_STORED:
                    compressed += 1
                    continue
                out[m[1]] = {'zip': rel(zp), 'entry': info.filename, 'offset': data_offset(zp, info), 'size': info.file_size}
    return out, compressed


def scan_morphemes(zips):
    """take → (zip, 항목 이름)"""
    out = {}
    for zp in zips:
        z = zipfile.ZipFile(zp)
        for n in z.namelist():
            m = TAKE_RE.search(n)
            if m and n.endswith('.json'):
                out[m[1]] = (z, n)
    return out


def segments(morph, take):
    if take not in morph:
        return None, None
    z, n = morph[take]
    d = json.loads(z.read(n))
    segs = [(norm(a.get('name')), s['start'], s['end']) for s in sorted(d.get('data', []), key=lambda s: s['start'])
            for a in s.get('attributes', [])]
    return segs, d.get('metaData', {}).get('duration')


def find_reference(take: str, gloss: str, videos, morph, prefer_actor: str):
    """같은 문장의 영상 중 같은 촬영자 → 다른 촬영자 순으로 찾는다(정면 카메라 우선)."""
    m = TAKE_RE.fullmatch(take)
    if not m:  # 지문자(CROWD) 동작: 원본 영상을 받지 않아 비교 대상 아님
        return None, None
    kind_id = f'NIA_SL_{m[2]}{m[3]}'
    cands = sorted({t for t in videos if t.startswith(kind_id + '_')},
                   key=lambda t: (TAKE_RE.fullmatch(t)[4] != prefer_actor, TAKE_RE.fullmatch(t)[5] != 'F', t))
    for t in cands:
        segs, dur = segments(morph, t)
        if segs is None:
            continue
        hit = [s for s in segs if s[0] == gloss] if gloss else segs
        if not hit:
            continue
        start, end = (hit[0][1], hit[0][2]) if gloss else (min(s[1] for s in segs), max(s[2] for s in segs))
        return t, {'start': start, 'end': end, 'duration': dur, 'glosses': [s[0] for s in segs]}
    return None, None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default=str(ROOT / 'alhub_data'), help='AI-Hub 원본 ZIP이 있는 폴더(하위 폴더까지 찾음)')
    ap.add_argument('--actor', default='REAL02', help='아바타 동작을 만든 촬영자')
    a = ap.parse_args(argv)
    root = Path(a.root)
    zips = [p for p in root.rglob('*.zip') if p.stat().st_size > 0]
    video_zips = [p for p in zips if 'video' in p.name]
    morph_zips = [p for p in zips if 'morpheme' in p.name]
    videos, compressed = scan_videos(video_zips)
    morph = scan_morphemes(morph_zips)
    print(f'영상 ZIP {len(video_zips)}개 → mp4 {len(videos)}개 (압축돼 제외 {compressed}), 형태소 {len(morph)}개')

    # 비교 대상: 문장에서 잘라 낸 수어 단어 동작 + 단어 단독 촬영 예시
    targets = []
    idx = json.loads((ROOT / 'public/motions/aihub_gloss/index.json').read_text(encoding='utf-8'))
    for g, v in idx['items'].items():
        start, end = v['segment_sec']
        targets.append({'key': f"gloss:{g}", 'label': g, 'kind': 'gloss', 'motion_path': v['path'],
                        'motion_take': v['source_take'], 'motion_segment': [start, end], 'occurrences': v['occurrences']})
    reg = json.loads((ROOT / 'data/expressions.json').read_text(encoding='utf-8'))
    for e in reg['entries']:
        if e['expression_id'].startswith('AIHUB-SAMPLE-WORD') and e.get('motion_take'):
            targets.append({'key': f"word:{e['expression_id']}", 'label': e['korean'], 'kind': 'word',
                            'motion_path': e['motion_path'], 'motion_take': e['motion_take'], 'motion_segment': None})

    items, missing = [], []
    for t in targets:
        gloss = t['label'] if t['kind'] == 'gloss' else None
        ref, seg = find_reference(t['motion_take'], gloss, videos, morph, a.actor)
        if not ref:
            # 원본 영상이 없어도 목록에 넣는다(아바타 ↔ 국립국어원 표준 영상 비교용)
            missing.append(t['key'])
            items.append({**t, 'video_take': None, 'video': None, 'video_segment': None, 'video_duration': None,
                          'video_glosses': [], 'same_actor': False})
            continue
        actor = TAKE_RE.fullmatch(ref)[4]
        items.append({**t, 'video_take': ref, 'video': videos[ref], 'video_segment': [seg['start'], seg['end']],
                      'video_duration': seg['duration'], 'video_glosses': seg['glosses'],
                      'same_actor': actor == a.actor})
    items.sort(key=lambda x: (x['video_take'] is None, not x['same_actor'], x['kind'], -(x.get('occurrences') or 0), x['label']))
    out = {
        'format': 'sueon-video-compare/v1',
        'description': '원본 영상과 아바타 동작 비교표(개발·검수 전용). 영상은 ZIP 안 위치만 기록하며 배포하지 않는다.',
        'actor': a.actor, 'items': items, 'missing_video': missing,
        'summary': {'targets': len(targets), 'with_video': sum(i['video_take'] is not None for i in items),
                    'same_actor': sum(i['same_actor'] for i in items), 'video_actors': sorted({TAKE_RE.fullmatch(t)[4] for t in videos})},
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    s = out['summary']
    print(f"비교 대상 {s['targets']}개 중 영상 있음 {s['with_video']}개 (같은 촬영자 {s['same_actor']}개) → {rel(OUT)}")
    print(f"영상 촬영자: {', '.join(s['video_actors']) or '없음'}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
