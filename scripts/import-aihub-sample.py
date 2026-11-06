#!/usr/bin/env python3
"""이용 신청으로 받은 AI-Hub 경량 샘플을 VRM 실험 모션으로 변환한다.

표현의 한국어 뜻/언어적 정확성을 판정하지 않는다. 공개 배포 권한도 자동으로 얻지 않는다.
"""
import argparse
import json
import math
import re
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data/expressions.json'
OUT = ROOT / 'public/motions/sample'


def vec(a, b):
    return [b[i] - a[i] for i in range(3)]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def norm(v):
    mag = math.sqrt(dot(v, v))
    return [x / mag for x in v] if mag > 1e-7 else [0.0, 0.0, 0.0]


def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]


def mul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return [aw*bx+ax*bw+ay*bz-az*by, aw*by-ax*bz+ay*bw+az*bx,
            aw*bz+ax*by-ay*bx+az*bw, aw*bw-ax*bx-ay*by-az*bz]


def inv(q):
    return [-q[0], -q[1], -q[2], q[3]]


def unitq(q):
    mag = math.sqrt(sum(x*x for x in q))
    return [x/mag for x in q] if mag > 1e-8 else [0, 0, 0, 1]


def from_to(a, b):
    a, b = norm(a), norm(b)
    if dot(a, a) < .5 or dot(b, b) < .5:
        return [0, 0, 0, 1]
    d = max(-1.0, min(1.0, dot(a,b)))
    if d < -.9999:
        axis = norm(cross(a, [0, 1, 0]))
        if dot(axis, axis) < .1:
            axis = norm(cross(a, [0, 0, 1]))
        return [*axis, 0.0]
    return unitq([*cross(a,b),1+d])


def rotate(q, v):
    return mul(mul(q, [*v,0]), inv(q))[:3]


def zrot(deg):
    h=math.radians(deg)/2
    return [0,0,math.sin(h),math.cos(h)]


def angle(a, b):
    a, b = norm(a), norm(b)
    return math.degrees(math.acos(max(-1,min(1,dot(a,b)))))


def positions(values):
    # 원본 3D는 y가 아래 방향으로 증가하고 z는 카메라 깊이다.
    # VRM 정면(+Z) 기준의 대략적인 축으로 바꿔 사용한다.
    return [(values[i], -values[i+1], -values[i+2]) for i in range(0,len(values),4)]


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def make_pose(raw):
    p = raw['people']
    pose = positions(p['pose_keypoints_3d'])
    bones = {}
    # BODY_25: RShoulder=2, RElbow=3, RWrist=4; LShoulder=5, LElbow=6, LWrist=7
    for side, ids in [('right', (2,3,4)),('left',(5,6,7))]:
        shoulder, elbow, wrist = (pose[k] for k in ids)
        ref = [-1,0,0] if side=='right' else [1,0,0]
        upper = from_to(ref, vec(shoulder,elbow))
        global_forearm = from_to(ref,vec(elbow,wrist))
        lower = unitq(mul(inv(upper),global_forearm))
        bones[f'{side}UpperArm'] = upper
        bones[f'{side}LowerArm'] = lower
        pts = positions(p[f'hand_{side}_keypoints_3d'])
        # 손바닥/손목의 기본 방향은 실제 모델·손의 축을 확인하여 추후 보정해야 한다.
        wrist_dir = vec(pts[0],pts[9])
        global_hand = from_to(ref,wrist_dir)
        bones[f'{side}Hand'] = unitq(mul(inv(global_forearm),global_hand))
        sign = 1 if side=='right' else -1
        for name, idx in [('Thumb',(1,2,3,4)),('Index',(5,6,7,8)),
                          ('Middle',(9,10,11,12)),('Ring',(13,14,15,16)),('Little',(17,18,19,20))]:
            a,b,c,d=(pts[k] for k in idx)
            palm = norm(vec(pts[0],pts[9]))
            base = norm(vec(a,b))
            first = clamp(angle(palm,base),0,75)
            # 손가락 벌림과 굽힘이 혼재하므로 이 각도는 '근사 시각화'다.
            second = clamp(angle(vec(a,b),vec(b,c)),0,100)
            third = clamp(angle(vec(b,c),vec(c,d)),0,75)
            if name=='Thumb':
                bones[f'{side}ThumbMetacarpal']=zrot(sign*first*.4)
                bones[f'{side}ThumbProximal']=zrot(sign*second)
                bones[f'{side}ThumbDistal']=zrot(sign*third)
            else:
                bones[f'{side}{name}Proximal']=zrot(sign*first)
                bones[f'{side}{name}Intermediate']=zrot(sign*second)
                bones[f'{side}{name}Distal']=zrot(sign*third)
    return {k:[round(x,6) for x in unitq(v)] for k,v in bones.items()}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('sample',help='본인이 이용권한을 확보한 AI-Hub 경량 샘플 ZIP 경로')
    parser.add_argument('--limit',type=int,default=8,help='생성할 샘플 동작 개수')
    args=parser.parse_args()
    if not Path(args.sample).is_file():parser.error('파일을 찾지 못했습니다')
    with zipfile.ZipFile(args.sample) as z:
        frame_groups=defaultdict(list)
        pattern=re.compile(r'/NIA_SL_(WORD\d+)_REAL01_F/(?:NIA_SL_\1_REAL01_F_)(\d+)_keypoints.json$')
        for n in z.namelist():
            m=pattern.search(n)
            if m:frame_groups[m.group(1)].append((int(m.group(2)), n))
        if not frame_groups: parser.error('REAL/WORD/01_real_word_keypoint 구조의 F각도 키포인트를 찾을 수 없습니다')
        OUT.mkdir(parents=True,exist_ok=True)
        registry=json.loads(DATA.read_text(encoding='utf-8'))
        registry['entries']=[e for e in registry['entries'] if not str(e['expression_id']).startswith('AIHUB-SAMPLE-')]
        # 기 확보한 REAL16_F 형태소 표제어는 다시 가져올 때도 유지한다.
        manifest_path = DATA.parent/'aihub_morphemes.json'
        glosses = {i['word_id']:i for i in json.loads(manifest_path.read_text(encoding='utf-8'))['items']} if manifest_path.exists() else {}
        created=[]
        for code in sorted(frame_groups)[:max(0,args.limit)]:
            frames=sorted(frame_groups[code]); sampled=frames[::4]
            keyframes=[]
            for index, filename in sampled:
                raw=json.loads(z.read(filename))
                try: bones=make_pose(raw)
                except (KeyError, IndexError, ValueError, TypeError):continue
                keyframes.append({'t':round(index/30.0,3),'bones':bones})
            if len(keyframes)<2:continue
            duration=round(max(keyframes[-1]['t'],0.01),3)
            # 원본 추출값을 임의로 한국수어라고 명명하지 않는다.
            clip={'format':'sueon-keyframes/v1','motion_id':f'AIHUB-SAMPLE-{code}',
                  'kind':'test','label':f'AI-Hub {code} 원본 3D 키포인트 근사 동작',
                  'space':'vrm-normalized-humanoid','duration':duration,
                  'source':'AI-Hub 수어 영상(데이터셋 103), 이용 신청으로 받은 경량 샘플에서 실험적으로 파생; 한국수어 의미·정확성 미검증',
                  'keyframes':keyframes}
            path=OUT/f'{code.lower()}_approx.json'
            path.write_text(json.dumps(clip,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
            gloss=glosses.get(code)
            entry={'expression_id':f'AIHUB-SAMPLE-{code}','kind':'test',
                   'korean':gloss['korean'] if gloss else f'{code} (의미 미확인)',
                   'match':[f'#{code}',gloss['korean']] if gloss else [f'#{code}'],
                   'motion_path':f'/motions/stabilized/{code.lower()}_stabilized.json' if gloss else f'/motions/sample/{path.name}',
                   'source':(clip['source']+'; 형태소 출처 '+gloss['source_file']) if gloss else clip['source'],
                   'verification_status':'not_sign_language','supported':True,
                   'note':'표제어는 REAL16_F 형태소에서 확인했으나 근사 모션 원본 촬영자·정확도 미검증.' if gloss else '동작 의미 미확인. 한국수어 번역 결과 아님.'}
            if gloss:
                entry.update({'morpheme_ref':code,'motion_source_actor':'unknown','source_video':gloss['source_video'],
                              'gloss_interval_sec':[gloss['gloss_start_sec'],gloss['gloss_end_sec']],
                              'motion_quality':'experimental_unvalidated'})
            registry['entries'].append(entry)
            created.append((code,len(keyframes),duration))
        registry['notice']='AI-Hub 형태소 표제어는 일부 확인했으나, 근사 모션의 촬영자 일치와 한국수어 동작 정확성은 검증되지 않았습니다.'
        registry['updated']='2026-11-01'
        DATA.write_text(json.dumps(registry,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    for code,frames,seconds in created:print(f'{code}: {frames} keyframes, {seconds}s')
    print(f'생성 완료: {len(created)}개. 기존 형태소 연결 건은 python scripts/stabilize-sample-motions.py 를 다시 실행해야 합니다.')
    print('이용약관 확인 전 파생 자료를 공개 배포하지 마세요.')

if __name__=='__main__':main()
