#!/usr/bin/env python3
"""실제 렌더링 대신 VRM 파일 헤더, VRMC_vrm 휴머노이드 손가락 본 구조 확인."""
import json
import struct
from pathlib import Path

path=Path(__file__).resolve().parents[1]/'public/models/avatar.vrm'
with path.open('rb') as f:
    head=f.read(12)
    assert len(head)==12
    magic,version,length=struct.unpack('<4sII',head)
    assert magic==b'glTF' and version==2 and length==path.stat().st_size
    size,chunk=struct.unpack('<I4s',f.read(8))
    assert chunk==b'JSON'
    data=json.loads(f.read(size).decode('utf-8').strip(' \0'))
vrm=data['extensions']['VRMC_vrm']
bones=vrm['humanoid']['humanBones']
fingers=[name for name in bones if any(f in name for f in ('Thumb','Index','Middle','Ring','Little'))]
assert len(fingers)==30, f'손가락 본 {len(fingers)}개 (기대 30개)'
assert len(bones)>=50
print(f'PASS: glTF 2.0 GLB 컨테이너 / VRM 1.0(VRMC_vrm) 확장 / 휴머노이드 {len(bones)}개·손가락 {len(fingers)}개 본')
print('단, 실제 WebGL 화면에서 본이 올바르게 움직이는지는 확인하지 않았음')
