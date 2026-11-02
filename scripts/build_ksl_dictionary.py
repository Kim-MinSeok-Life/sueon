#!/usr/bin/env python3
"""국립국어원 한국수어사전 '한국어대응표현정보' CSV → 앱용 사전 JSON.

출처: 공공데이터포털 15135637 '문화체육관광부 국립국어원_한국수어사전_한국어대응표현정보'(이용허락범위 제한 없음).
- 같은 한국어라도 의미가 다르면 수어 표제어 번호가 다르다(예: 배 → 신체/과일/선박/배수).
- "(맛이)짜다"처럼 괄호 안 문맥 단서를 따로 보관해 문장 분석기의 의미 고르기에 쓴다.
- 일상생활 수어 전부 + 전문용어 수어 중 AI-Hub 문장 gloss와 같은 표현만 담는다(파일 크기 축소).
일반 데이터 변환이며 AI 학습이 아니다.

사용 예:
  python scripts/build_ksl_dictionary.py "문화체육관광부 국립국어원_한국수어사전_한국어대응표현정보_20240909.csv"
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/ksl/dictionary.json'
SEN_GLOSSES = ROOT / 'reports/aihub_sen_morpheme_report_real02.json'


def split_expr(e: str) -> tuple[str, str]:
    """'(맛이)짜다' → ('짜다', '맛이'), '으로⑤' → ('으로', '')"""
    ctx = ' '.join(re.findall(r'\(([^)]*)\)', e))
    word = re.sub(r'\([^)]*\)', '', e)
    word = re.sub(r'[①-⑳\d]+$', '', word).strip()
    return word, ctx.strip()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('csv')
    ap.add_argument('--out', default=str(OUT))
    a = ap.parse_args(argv)
    raw = Path(a.csv).read_bytes()
    text = raw.decode('utf-8-sig') if raw[:3] == b'\xef\xbb\xbf' else raw.decode('utf-8', errors='strict')
    rows = list(csv.DictReader(text.splitlines()))
    sen_gl = set()
    if SEN_GLOSSES.exists():
        sen = json.loads(SEN_GLOSSES.read_text(encoding='utf-8'))
        sen_gl = {re.sub(r'\d+$', '', g) for v in sen.values() for g in v['glosses']}
    entries = []
    for r in rows:
        exprs = [split_expr(e) for e in r['한국어 대응표현'].split(',') if e.strip()]
        exprs = [(w, c) for w, c in exprs if w]
        if not exprs:
            continue
        cat = [x.strip() for x in r['대/중 분류'].split('>')]
        daily = cat[0].startswith('일상생활')
        if not daily and not any(w in sen_gl for w, _ in exprs):
            continue
        entries.append({'id': int(r['수어 표제어 번호']), 'w': [[w, c] if c else [w] for w, c in exprs],
                        'c': ' > '.join(cat[1:]) if len(cat) > 1 else cat[0], 'd': daily,
                        'h': r['수형설명'].strip(), 'j': r['결합정보'].strip() or None})
    out = {
        'format': 'sueon-ksl-dictionary/v1',
        'source': '국립국어원 한국수어사전 한국어대응표현정보(공공데이터포털 15135637, 2024-09-09), 이용허락범위 제한 없음',
        'note': 'w=[한국어 대응표현, 괄호 문맥], c=분류, h=수형설명, j=결합정보. 수어 영상은 포함하지 않음.',
        'entries': entries,
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(entries)}개 수어 표제어 저장 → {a.out} ({Path(a.out).stat().st_size / 1024:.0f}KB)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
