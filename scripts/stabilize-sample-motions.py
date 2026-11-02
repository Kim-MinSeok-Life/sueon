#!/usr/bin/env python3
"""실험용 AI-Hub 근사 모션에서 비연속적인 팔꿈치·손목 회전량을 제한한다.

수어 정확도를 높이는 보정이 아니다. 원본 근사 모션을 남기고 별도 클립으로 생성한다.
소스 촬영자의 일치와 원본 영상 기준 궤적이 검증되기 전에는 전문가 검증 결과로 사용하지 않는다.
"""
from __future__ import annotations
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'public/motions/sample'
OUT = ROOT / 'public/motions/stabilized'
# 30fps 원본에서 4프레임마다 추출된 0.133초 단위 데이터의 급격한 뒤집힘 완화.
# 각 임계값은 기술 시연용 보수적 제한이며 사람 관절·수어 정확도 기준이 아니다.
MAX_DEGREES_PER_STEP = {'UpperArm': 75.0, 'LowerArm': 75.0, 'Hand': 55.0}


def normalized(q):
    length = math.sqrt(sum(x*x for x in q))
    if length < 1e-10:
        raise ValueError('크기가 0인 회전 쿼터니언')
    return [x/length for x in q]


def angle(a, b):
    return math.degrees(2*math.acos(min(1.0, abs(sum(x*y for x,y in zip(a,b))))))


def slerp(a, b, t):
    dot=sum(x*y for x,y in zip(a,b))
    if dot < 0:
        b=[-x for x in b]; dot=-dot
    dot=min(1.,max(-1.,dot))
    if dot > 0.9995:
        return normalized([x+t*(y-x) for x,y in zip(a,b)])
    theta=math.acos(dot)
    sine=math.sin(theta)
    w1=math.sin((1-t)*theta)/sine
    w2=math.sin(t*theta)/sine
    return normalized([w1*x+w2*y for x,y in zip(a,b)])


def limit_for(name):
    for suffix, limit in MAX_DEGREES_PER_STEP.items():
        if name in ('left'+suffix, 'right'+suffix):
            return limit
    return None


def stabilize(raw):
    previous={}
    corrected=0
    for frame in raw['keyframes']:
        for bone,q in frame['bones'].items():
            q=normalized(q)
            cap=limit_for(bone)
            if cap is not None and bone in previous:
                deg=angle(previous[bone],q)
                if deg>cap:
                    q=slerp(previous[bone],q,cap/deg)
                    corrected+=1
            frame['bones'][bone]=[round(x,6) for x in normalized(q)]
            # 반올림 이후 다시 정규화 오차(1e-6 미만) 허용.
            previous[bone]=normalized(frame['bones'][bone])
    return corrected


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    for source in sorted(SOURCE.glob('word15*_approx.json')):
        raw=json.loads(source.read_text(encoding='utf-8'))
        altered=stabilize(raw)
        word=source.stem.split('_')[0].upper()
        raw['label']=f'AI-Hub {word} 근사 동작 (관절 급회전 제한, 한국수어 정확도 미검증)'
        raw['source']+='; 기술 시연용 팔·손목 인접 키프레임 각도 제한 후처리(정확성 검증 아님)'
        raw['processing']={'method':'adjacent_quaternion_angle_limit/v1',
                           'step_angle_limits_degrees':MAX_DEGREES_PER_STEP,
                           'corrected_keyframe_bones':altered,
                           'source_motion':f'/motions/sample/{source.name}',
                           'clip_trim_applied':False,
                           'source_actor_verified':False}
        out=OUT/f'{source.stem.replace("_approx", "_stabilized")}.json'
        out.write_text(json.dumps(raw,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
        print(f'{source.name} -> {out.name}: 급격한 회전 {altered}회 제한')

if __name__=='__main__':main()
