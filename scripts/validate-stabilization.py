#!/usr/bin/env python3
"""원본/안정화 모션 동일 키프레임 구조 및 최대 관절 회전차 검증."""
from pathlib import Path
import json
import math
import sys

root=Path(__file__).resolve().parents[1]/'public/motions'
errors=[]
changed=0
for i in range(1501,1509):
    a=json.loads((root/f'sample/word{i}_approx.json').read_text(encoding='utf-8'))
    b=json.loads((root/f'stabilized/word{i}_stabilized.json').read_text(encoding='utf-8'))
    if (a['motion_id'],a['duration'],a['kind']) != (b['motion_id'],b['duration'],b['kind']):
        errors.append(f'WORD{i} 모션 메타데이터 불일치')
    if len(a['keyframes'])!=len(b['keyframes']):errors.append(f'WORD{i} 키프레임 수 변경')
    if b.get('processing',{}).get('source_motion')!=f'/motions/sample/word{i}_approx.json':
        errors.append(f'WORD{i} 원본 링크 불일치')
    limits=b['processing']['step_angle_limits_degrees']
    corrected=b['processing']['corrected_keyframe_bones']
    changed+=corrected
    for j,frame in enumerate(b['keyframes']):
        if frame['t'] != a['keyframes'][j]['t']:
            errors.append(f'WORD{i} 키프레임 시간 변경')
        for bone,quat in frame['bones'].items():
            if abs(math.sqrt(sum(q*q for q in quat))-1)>1e-3:
                errors.append(f'WORD{i} {bone} 비정규 쿼터니언')
            if j==0:continue
            for suffix,deg_limit in limits.items():
                if bone not in ('left'+suffix,'right'+suffix):continue
                prev=b['keyframes'][j-1]['bones'][bone]
                dot=abs(sum(x*y for x,y in zip(prev,quat)))
                deg=math.degrees(2*math.acos(min(1,dot)))
                if deg>deg_limit+0.01:
                    errors.append(f'WORD{i} {bone} {j} 급회전 {deg:.2f}° > {deg_limit}°')
print(f'모션 8개, 급격 회전 제한 적용 {changed}회')
for e in errors[:20]:print('FAIL:',e,file=sys.stderr)
if errors:sys.exit(1)
print('PASS: 기계적 연속성 검증 (한국수어 동작 정확도 검증 아님)')
