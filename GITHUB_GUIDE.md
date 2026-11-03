# SUEO:N GitHub 올리기·협업 가이드

> 명령줄(CLI) 방식, Windows PowerShell 기준입니다(Mac 차이는 표에 함께 적음). `<...>`는 본인 값으로 바꾸고 괄호도 지웁니다.

| 절 | 내용 | 누가 |
|---|---|---|
| 0 | 먼저 정할 것 · GitHub와 ZIP의 차이 | 모두 |
| 1~3 | 도구 설치 · Git 설정 · 로그인 | 처음 한 번 |
| 4~5 | 처음 올리기 · 저장소 설정 | 만든 사람 1명 |
| 6 | 받아서 실행하기 | 팀원 |
| 7 | 매일 작업 흐름(브랜치 → PR → 병합) | 모두 |
| 8~9 | 자주 생기는 문제 · 명령 요약 | 모두 |

---

## 0. 먼저 정할 것

| 항목 | 결정 |
|---|---|
| 저장소 이름 | **`sueon`** (GitHub 이름에는 `:`를 못 써요) |
| 공개 범위 | **Public(공개)** — 2026-11-03 팀 결정. 누구나 보고 받을 수 있음. 올리기(push)는 초대한 팀원만 |
| 설명 | SUEO:N - Korean speech/text to Korean Sign Language 3D avatar web app (in development) |

**GitHub와 ZIP은 용도가 다릅니다**

| | GitHub (소스) | 공유 ZIP (바로 실행) |
|---|---|---|
| 담는 것 | 코드·문서·테스트·아바타·사전·**AI-Hub 파생 동작 파일** | 위 + 발췌 키포인트(`data/keypoints/`) |
| 빠지는 것 | AI-Hub 원본, 발췌 키포인트, `.env.local` | AI-Hub 원본, `.env.local` |
| 만드는 법 | `git push` (또는 `make_release_zip.py ... --github`로 같은 내용 ZIP) | `python scripts/make_release_zip.py <밖경로.zip>` |
| 팀원이 쓰는 법 | `gh repo clone` 후 바로 설치·실행(6절) | 압축 풀고 바로 실행 |

> **동작 파일도 Git에 올리는 이유:** 팀 결정(2026-11-02 포함, 2026-11-03 저장소 공개). AI-Hub 데이터는 경진대회 목적으로 이용약관에 동의하고 받았고, AI 학습용으로 명시돼 있습니다. 동작 파일의 재사용 조건은 AI-Hub 이용약관을 따릅니다. **원본(ZIP·영상)과 원본 좌표를 그대로 잘라 낸 발췌 키포인트는 올리지 않습니다.** 웹 서비스로 배포할 때 동작 경로를 막는 장치(`src/proxy.ts`)는 그대로 둡니다.

---

## 1. 도구 설치 (처음 한 번)

| 순서 | Windows | Mac | 확인 |
|:---:|---|---|---|
| ① Git | 대부분 설치돼 있음 · 없으면 `winget install --id Git.Git -e` | `xcode-select --install` | `git --version` |
| ② GitHub CLI | `winget install --id GitHub.cli -e` | `brew install gh` | `gh --version` |

> 설치한 뒤에는 **터미널을 새로 열어야** 명령이 인식됩니다.

---

## 2. Git 기본 설정 (처음 한 번)

| 명령 | 하는 일 |
|---|---|
| `git config --global user.name "<GitHub 아이디>"` | 커밋에 남는 이름 |
| `git config --global user.email "<GitHub 이메일>"` | 커밋에 남는 이메일 |
| `git config --global init.defaultBranch main` | 기본 브랜치 이름을 main으로 |
| `git config --global core.autocrlf true` (Mac은 `input`) | 줄바꿈 자동 변환 |
| `git config --global core.quotepath false` | 한글 파일 이름이 `\354...`로 깨지지 않게 |
| `git config --global --list` | 설정 확인 |

> 이메일을 숨기려면 GitHub → Settings → Emails의 `...@users.noreply.github.com` 주소를 쓰세요.

---

## 3. GitHub 로그인 (처음 한 번)

`gh auth login` 을 실행하고 질문에 이렇게 답합니다(화살표 키 + Enter).

| 질문 | 고를 것 |
|---|---|
| Where do you use GitHub? | `GitHub.com` |
| Preferred protocol | `HTTPS` |
| Authenticate Git with your GitHub credentials? | `Yes` |
| How would you like to authenticate? | `Login with a web browser` → 8자리 코드 복사 → 브라우저에 붙여넣고 승인 |

확인: `gh auth status`

---

## 4. 처음 올리기 (저장소 만든 사람 1명만)

| 단계 | 명령 | 확인할 것 |
|:---:|---|---|
| ① 폴더 이동 | `cd <프로젝트 폴더>\sueon` | 프롬프트 끝이 `\sueon>` 인지(`package.json`이 있는 폴더) |
| ② Git 시작 | `git init` | |
| ③ 올라갈 파일 보기 | `git status --short --untracked-files=all` | 목록 훑어보기 |
| ④ **위험 파일 검사** | 아래 상자의 명령 | **아무것도 안 나와야 안전** |
| ⑤ 담기 | `git add .` | `LF will be replaced by CRLF` 경고는 무시 |
| ⑥ 첫 커밋 | `git commit -m "init: SUEO:N MVP"` | 메시지는 영어로(한글을 넣으면 IntelliJ 터미널이 멈출 수 있음) |
| ⑦ 저장소 만들고 올리기 | `gh repo create sueon --public --source . --remote origin --push --description "SUEO:N - Korean speech/text to Korean Sign Language 3D avatar web app"` | 설명을 한글로 쓰려면 GitHub 웹의 About ⚙에서 |
| ⑧ 웹에서 확인 | `gh repo view --web` | 이름 옆에 **Public** 표시 |

④ 위험 파일 검사 — 원본 데이터·발췌 키포인트·API 키가 목록에 있으면 출력됩니다. **아무것도 안 나오면 ⑤로.** 뭔가 나오면 멈추고 개발 담당자에게 보여 주세요. (`public/motions/...` 동작 파일은 올라가는 게 정상이라 검사하지 않습니다.)

```powershell
git status --short --untracked-files=all | Select-String "alhub_data|data/keypoints/|data/video_compare|\.env\.local|\.zip|\.mp4"
```

> Mac은 `Select-String "…"` 대신 `grep -E "…"` 를 씁니다.

**`gh` 없이 하려면** GitHub 웹 → New repository → 이름 `sueon`, **Public**, README 추가 안 함 → 만든 뒤:

| 명령 |
|---|
| `git remote add origin https://github.com/<아이디>/sueon.git` |
| `git branch -M main` |
| `git push -u origin main` |

---

## 5. 저장소 설정 (만든 사람)

| 하고 싶은 것 | 명령 |
|---|---|
| 이슈 켜기·위키 끄기·병합 후 브랜치 자동 삭제 | `gh repo edit --enable-issues --enable-wiki=false --delete-branch-on-merge` |
| 주제 태그 | `gh repo edit --add-topic sign-language --add-topic ksl --add-topic vrm --add-topic nextjs --add-topic threejs` |
| 팀원 초대(쓰기 권한, 1명씩) | `gh api -X PUT repos/<내아이디>/sueon/collaborators/<팀원아이디> -f permission=push` |

- 팀원은 이메일이나 https://github.com/notifications 에서 초대를 **수락**해야 합니다.
- **main 보호(선택)**: Settings → Branches(또는 Rules → Rulesets) → `main` → "Require a pull request before merging". 공개 저장소는 무료 계정에서도 쓸 수 있어요. 켜면 main에는 PR로만 합칠 수 있습니다.

---

## 6. 팀원: 받아서 실행하기

| 단계 | Windows | Mac |
|:---:|---|---|
| ① 받기 | `gh repo clone <만든사람아이디>/sueon` | 같음 |
| ② 폴더 이동 | `cd sueon` | 같음 |
| ③ 설치 | `npm.cmd ci` | `npm ci` |
| ④ 실행 | `npm.cmd run dev` → http://localhost:3001 | `npm run dev` |
| ⑤ 키포인트 복사(선택, 개발용) | `robocopy C:\tmp\sueon_share\sueon\data\keypoints data\keypoints /E` | `cp -R ~/Downloads/sueon_share/sueon/data/keypoints data/` |

> 수어 동작 파일은 저장소에 들어 있어 ①~④만 하면 아바타가 움직입니다. ⑤는 리타기팅 실험(`retarget_vrm.py`)을 할 사람만, 팀 공유 ZIP을 `C:\tmp\sueon_share`(Mac은 다운로드의 `sueon_share`)에 풀었다고 가정한 경로입니다.

---

## 7. 매일 작업 흐름 (브랜치 → PR → 병합)

| 단계 | 명령 | 설명 |
|:---:|---|---|
| ① 최신 받기 | `git switch main` → `git pull` | 작업 전 항상 |
| ② 브랜치 만들기 | `git switch -c feature/<작업이름>` | 예: `feature/llm-key`, `fix/face-depth`, `docs/mentoring2` |
| ③ 확인 | `npm.cmd test` → `git status` | 테스트 통과 확인 |
| ④ 저장 | `git add -A` → `git commit -m "feat: <한 줄 설명>"` | |
| ⑤ 올리기 | `git push -u origin feature/<작업이름>` | |
| ⑥ PR 만들기 | `gh pr create --base main --fill` | 제목·본문은 커밋 내용으로 채워짐 |
| ⑦ 리뷰·병합 | `gh pr view --web` → `gh pr merge --squash --delete-branch` | |
| ⑧ 정리 | `git switch main` → `git pull` | |

**커밋 메시지 머리말**

| 머리말 | 뜻 | 머리말 | 뜻 |
|---|---|---|---|
| `feat:` | 기능 | `refactor:` | 구조 정리 |
| `fix:` | 버그 | `test:` | 테스트 |
| `docs:` | 문서 | `chore:` | 설정·도구 |

---

## 8. 자주 생기는 문제

| 증상 | 해결 |
|---|---|
| `rejected ... fetch first` (push 거부) | 다른 사람이 먼저 올림 → `git pull --rebase` 후 다시 `git push` |
| 충돌(conflict) | `git status`로 파일 확인 → `<<<<<<<`~`>>>>>>>` 부분을 직접 고침 → `git add <파일>` → `git rebase --continue` |
| `File ... exceeds 100MB` | `git rm --cached <파일>` → `.gitignore`에 추가 → 다시 커밋 |
| **API 키를 실수로 커밋** | 발급 사이트에서 **즉시 폐기·재발급**. 이력에서 지우는 것만으로는 안전하지 않음 |
| 한글 파일명이 `\354...` | `git config --global core.quotepath false` |
| `LF will be replaced by CRLF` | 줄바꿈 안내라 무시 |
| `gh: command not found` | 설치 후 터미널을 새로 열지 않음 → 새 창에서 다시 |
| 실행했는데 404·옛 화면 | 다른 폴더(예전 사본)의 서버가 3001을 쓰는 중 → 그 터미널에서 `Ctrl+C` 후 올바른 폴더에서 실행 |

---

## 9. 명령 요약

| 하고 싶은 것 | 명령 |
|---|---|
| 상태 / 변경 내용 / 이력 | `git status` / `git diff` / `git log --oneline -n 20` |
| 브랜치 목록 / 이동 | `git branch -a` / `git switch <이름>` |
| 받기 / 올리기 | `git pull` / `git push` |
| 마지막 커밋 메시지 고치기(push 전) | `git commit --amend` |
| 저장 안 한 수정 되돌리기 | `git restore <파일>` |
| PR 목록 / 상태 | `gh pr list` / `gh pr status` |
| 저장소 웹으로 열기 | `gh repo view --web` |
