#!/usr/bin/env python3
"""형태소 원본·표현 사전·동작의 출처 구분을 검사한다."""
from pathlib import Path
import json
import sys

root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'data/aihub_morphemes.json').read_text(encoding='utf-8'))
registry=json.loads((root/'data/expressions.json').read_text(encoding='utf-8'))
refs={x['morpheme_ref']:x for x in registry['entries'] if x.get('morpheme_ref')}
errors=[]
items=manifest['items']
if len(items)<8 or len({x['word_id'] for x in items})!=len(items):
    errors.append('형태소 8개 이상 또는 ID 유일성 위반')
for row in items:
    id=row['word_id']
    raw=json.loads((root/row['source_file']).read_text(encoding='utf-8'))
    info=raw['metaData']; annotation=raw['data'][0]
    names=[x['name'] for x in annotation['attributes']]
    if names!=[row['korean']]:errors.append(f'{id}: 원본 표제어 불일치')
    if info['name']!=row['source_video'] or info['url']!=row['source_video_url']:
        errors.append(f'{id}: 원본 영상 참조 불일치')
    if not (0<=row['gloss_start_sec']<row['gloss_end_sec']<=info['duration']):
        errors.append(f'{id}: 형태소 구간 오류')
    if (annotation['start'],annotation['end'])!=(row['gloss_start_sec'],row['gloss_end_sec']):
        errors.append(f'{id}: 원본 시간 불일치')
    e=refs.get(id)
    if not e: errors.append(f'{id}: 등록된 표현 없음');continue
    if e['korean']!=row['korean'] or row['korean'] not in e['match']:
        errors.append(f'{id}: 표현 매핑 오류')
    # 표제어(형태소)와 모션은 같은 촬영본(REAL02_F)에서 와야 한다 — 단어 ID가 같아도 촬영자마다 표제어가 다른 경우가 실측됨
    if (e['kind'],e['verification_status'],e.get('motion_source_actor'))!=('test','not_sign_language','REAL02'):
        errors.append(f'{id}: 촬영자·검증 상태 위반')
    if row['morpheme_actor']!=e.get('motion_source_actor') or f"NIA_SL_{id}_{row['morpheme_actor']}_{row['morpheme_camera']}"!=e.get('motion_take'):
        errors.append(f'{id}: 형태소 촬영본과 모션 촬영본 불일치')
    if e.get('label_motion_same_actor') is not True or row.get('label_motion_same_actor') is not True:
        errors.append(f'{id}: 같은 촬영자 표시 누락')
    if e.get('gloss_interval_sec')!=[row['gloss_start_sec'],row['gloss_end_sec']]:
        errors.append(f'{id}: 형태소 구간 매핑 오류')
    if not e['motion_path'].startswith('/motions/aihub_real02/'):
        errors.append(f'{id}: REAL02 리타기팅 모션을 선택하지 않음')
    motion=json.loads((root/'public'/e['motion_path'].lstrip('/')).read_text(encoding='utf-8'))
    if motion['kind']!='test' or motion.get('retarget',{}).get('take')!=e.get('motion_take'):
        errors.append(f'{id}: 실험용 모션 출처(촬영본) 불일치')
    if not str(motion.get('retarget',{}).get('trim','')).startswith('morpheme '+e.get('motion_take','')):
        errors.append(f'{id}: 형태소 구간으로 자르지 않음')
    if motion['motion_id']!=f"AIHUB-REAL02-{id}": errors.append(f'{id}: 모션 ID 불일치')
    if e.get('legacy_motion_path'):
        legacy=json.loads((root/'public'/e['legacy_motion_path'].lstrip('/')).read_text(encoding='utf-8'))
        if legacy.get('processing',{}).get('source_actor_verified') is not False:
            errors.append(f'{id}: 이전 근사 모션 검증 상태 오류')
print(f'형태소 원본·모션 출처 검증: {len(items)}개')
for err in errors: print('FAIL:',err,file=sys.stderr)
if errors:sys.exit(1)
print('PASS: 메타데이터 일치 (동작 정확도 검증 아님)')
