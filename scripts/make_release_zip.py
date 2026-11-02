#!/usr/bin/env python3
"""공유용 ZIP 만들기: 실행에 필요한 파일만 담고 원본 대용량 자료는 뺀다.

빼는 것: node_modules, .next, AI-Hub 원본 ZIP·폴더(alhub_data/, 수어 영상/, 004.수어영상/, aihub_download/),
         참고 PDF·도구 문서, AI-Hub 모델 코드(03.AI모델/), 비밀 설정(.env*), IntelliJ 설정(.idea)
담는 것: 소스·스크립트·테스트·문서(개발자참고.pdf 포함), 아바타, 파생 동작 JSON(public/motions), 사전(public/ksl), 발췌 키포인트(data/)

--github: GitHub에 올라갈 파일만 담는다(.gitignore 기준을 git으로 직접 적용). 파생 동작은 담고, 발췌 키포인트·비교표는 빠진다.
          git이 설치돼 있어야 하며, 프로젝트 폴더에 .git을 만들지 않는다(임시 폴더 사용).

사용 예:
  python scripts/make_release_zip.py ..\\sueon_share.zip
  python scripts/make_release_zip.py ..\\sueon_github.zip --github
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {'node_modules', '.next', '__pycache__', '.git', '.idea', 'test-results',
             '수어 영상', '004.수어영상', 'aihub_download', '03.AI모델', 'alhub_data', 'aihub_data'}
SKIP_EXT = {'.zip', '.irx638', '.pdf', '.docx', '.pptx', '.csv', '.tsbuildinfo', '.mp4'}


KEEP = {'개발자참고.pdf'}  # 참고 PDF는 빼되, 직접 만든 개발자 설명서는 담는다


def skip(rel: Path) -> bool:
    name = rel.name
    if len(rel.parts) == 1 and name in KEEP:
        return False
    if name.startswith('.env') and name != '.env.example':
        return True
    if name == 'next-env.d.ts':
        return True
    return rel.suffix.lower() in SKIP_EXT or any(part.lower().endswith('.irx638') for part in rel.parts)


# GitHub용인데 이런 경로가 나오면 .gitignore가 깨진 것이므로 ZIP을 만들지 않는다(원본 데이터·원본 좌표 발췌·비밀 설정)
GITHUB_FORBIDDEN = re.compile(
    r'(^|/)(alhub_data|aihub_data|aihub_download|수어 영상|004\.수어영상)/'
    r'|^data/keypoints/|^data/video_compare\.json$|(^|/)\.env(?!\.example$)|\.(zip|mp4)$')


def github_files() -> list[Path]:
    """git이 .gitignore를 적용했을 때 올라갈 파일 목록(이미 커밋된 파일 + 새 파일)"""
    with tempfile.TemporaryDirectory() as tmp:
        gitdir = Path(tmp) / 'g'
        subprocess.run(['git', 'init', '-q', '--bare', str(gitdir)], check=True)
        out = subprocess.run(['git', f'--git-dir={gitdir}', f'--work-tree={ROOT}', '-c', 'core.quotepath=false',
                              'ls-files', '--others', '--cached', '--exclude-standard', '-z'],
                             check=True, capture_output=True, cwd=ROOT).stdout.decode('utf-8')
    return sorted(Path(x) for x in out.split('\0') if x)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out', help='만들 ZIP 경로(프로젝트 폴더 밖 권장)')
    ap.add_argument('--github', action='store_true', help='GitHub에 올라갈 파일만(.gitignore 기준)')
    a = ap.parse_args(argv)
    out = Path(a.out).resolve()
    if ROOT in out.parents:
        ap.error('ZIP은 프로젝트 폴더 밖에 만들어 주세요(자기 자신을 담지 않도록).')
    n = size = 0
    if a.github:
        files = github_files()
        bad = [f.as_posix() for f in files if GITHUB_FORBIDDEN.search(f.as_posix())]
        if bad:
            ap.error('GitHub용 목록에 원본·파생 데이터가 섞였습니다. .gitignore를 확인하세요: ' + ', '.join(bad[:10]))
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for rel in files:
                p = ROOT / rel
                z.write(p, Path('sueon') / rel)
                n += 1
                size += p.stat().st_size
        print(f'[GitHub용] {n}개 파일, 원본 {size / 1e6:.1f}MB → {out} ({out.stat().st_size / 1e6:.1f}MB)')
        return 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for dp, dns, fns in os.walk(ROOT):
            dns[:] = [d for d in dns if d not in SKIP_DIRS]
            for f in fns:
                p = Path(dp) / f
                rel = p.relative_to(ROOT)
                if skip(rel):
                    continue
                z.write(p, Path('sueon') / rel)
                n += 1
                size += p.stat().st_size
    print(f'{n}개 파일, 원본 {size / 1e6:.1f}MB → {out} ({out.stat().st_size / 1e6:.1f}MB)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
