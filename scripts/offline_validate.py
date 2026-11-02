#!/usr/bin/env python3
"""npm 설치 없이 표현·모션 파일의 필수 무결성을 검사한다."""
import json
import math
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
registry = json.loads((root / 'data/expressions.json').read_text(encoding='utf-8'))
allowed_status = {'verified', 'unverified', 'data_pending', 'not_sign_language'}
errors = []
ids = set()
matches = set()
clips = 0

for item in registry['entries']:
    label = item['expression_id']
    if label in ids: errors.append(f'{label}: 중복 ID')
    ids.add(label)
    for word in item['match']:
        if word in matches: errors.append(f'{label}: 중복 match {word}')
        matches.add(word)
    if item['kind'] not in {'ksl', 'test'}: errors.append(f'{label}: kind 오류')
    if item['verification_status'] not in allowed_status: errors.append(f'{label}: 상태 오류')
    if item['kind'] == 'test' and item['verification_status'] != 'not_sign_language':
        errors.append(f'{label}: test 검증 상태 오류')
    if item['kind'] == 'ksl' and item['verification_status'] == 'not_sign_language':
        errors.append(f'{label}: ksl 검증 상태 오류')
    if not item['motion_path']:
        if item['supported']: errors.append(f'{label}: 모션 없는 표현 지원 처리')
        continue
    if not item['source']: errors.append(f'{label}: 출처 누락')
    if not item['motion_path'].startswith('/motions/') or '..' in item['motion_path']:
        errors.append(f'{label}: 경로 위반')
        continue
    file = root / 'public' / item['motion_path'].lstrip('/')
    if not file.exists():
        errors.append(f'{label}: 파일 누락')
        continue
    try: motion = json.loads(file.read_text(encoding='utf-8'))
    except Exception as e:
        errors.append(f'{label}: JSON 파싱 실패 {e}')
        continue
    clips += 1
    if motion['kind'] != item['kind'] or motion['format'] != 'sueon-keyframes/v1' or motion['space'] != 'vrm-normalized-humanoid':
        errors.append(f'{label}: 모션 계약 불일치')
    if motion['duration'] <= 0 or len(motion['keyframes']) < 2:
        errors.append(f'{label}: 길이/프레임 수 오류')
    prev = -1
    for frame in motion['keyframes']:
        t = frame['t']
        if t < prev or t > motion['duration'] + 1e-5: errors.append(f'{label}: 타임스탬프 오류')
        prev = t
        for name,q in frame['bones'].items():
            if not isinstance(q,list) or len(q) != 4 or not all(math.isfinite(x) for x in q):
                errors.append(f'{label}: {name} 회전값 오류')
            elif abs(math.sqrt(sum(x*x for x in q)) - 1) > 1e-3:
                errors.append(f'{label}: {name} 비정규화 쿼터니언')
print(f'표현: {len(registry["entries"])}건 / 모션: {clips}건')
print(f'원본 한국수어 의미 확인 및 검증된 모션: {len([e for e in registry["entries"] if e["kind"] == "ksl" and e["supported"] and e["verification_status"] == "verified"])}건')
if errors:
    print('검사 실패:',*errors[:20],sep='\n - ')
    sys.exit(1)
print('데이터 구조 무결성 검사 통과 (의미·3D 정확성 검증 아님)')
