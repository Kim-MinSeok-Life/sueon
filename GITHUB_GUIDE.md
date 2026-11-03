# SUEO:N GitHub 올리기·협업 가이드

> 명령줄(CLI) 방식, Windows PowerShell 기준입니다(Mac 차이는 표에 함께 적음). `<...>`는 본인 값으로 바꾸고 괄호도 지웁니다.

| 절 | 내용 | 누가 |
|---|---|---|
| 0 | 먼저 정할 것 · GitHub와 ZIP의 차이 | 모두 |
| 1~3 | 도구 설치 · Git 설정 · 로그인 | 처음 한 번 |
| 4~5 | 처음 올리기 · 저장소 설정 | 만든 사람 1명 |
| 6 | 받아서 실행하기 | 팀원 |
| 7 | **브랜치 전략**과 매일 작업 흐름(`tester` → `develop` → `main`) | 모두 |
| 8~9 | 자주 생기는 문제 · 명령 요약 | 모두 |

---

## 0. 먼저 정할 것

| 항목 | 결정 |
|---|---|
| 저장소 이름 | **`sueon`** (GitHub 이름에는 `:`를 못 써요) |
| 공개 범위 | **Public(공개)** — 2026-11-03 팀 결정. 누구나 보고 받을 수 있음. 올리기(push)는 초대한 팀원만 |
| 설명 | SUEO:N - Korean speech/text to Korean Sign Language 3D avatar web app (in development) |
| 브랜치 | `main`(최종) · `develop`(취합·확인) · `tester1`·`tester2`(각자 작업). 자세한 규칙은 7절 |

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
| ⑥ 첫 커밋 | `git commit -m "[시작] SUEO:N MVP"` | 메시지는 한국어로. Windows IntelliJ 터미널에서 한글 입력이 멈추면 7.3의 커밋 창 사용 |
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
| 이슈 켜기·위키 끄기 | `gh repo edit --enable-issues --enable-wiki=false` |
| 병합 후 브랜치 **자동 삭제 끄기** | `gh repo edit --delete-branch-on-merge=false` |

> ⚠️ `tester1`·`tester2`·`develop`은 계속 쓰는 브랜치라, "병합 후 브랜치 자동 삭제"를 켜면 PR을 합칠 때마다 지워집니다. **꺼 둔 상태를 유지하세요.**

| 하고 싶은 것 | 명령 |
|---|---|
| 주제 태그 | `gh repo edit --add-topic sign-language --add-topic ksl --add-topic vrm --add-topic nextjs --add-topic threejs` |
| 팀원 초대(쓰기 권한, 1명씩) | `gh api -X PUT repos/<내아이디>/sueon/collaborators/<팀원아이디> -f permission=push` |

- 팀원은 이메일이나 https://github.com/notifications 에서 초대를 **수락**해야 합니다.
- **main·develop 보호(선택)**: Settings → Rules → Rulesets → **New branch ruleset** → 대상에 `main`, `develop` 추가 → **Require a pull request before merging** 체크 → Create. 공개 저장소는 무료 계정에서도 쓸 수 있어요. 켜면 두 브랜치에는 PR로만 합칠 수 있어 실수로 바로 올리는 것을 막습니다.

---

## 6. 팀원: 받아서 실행하기

| 단계 | Windows | Mac |
|:---:|---|---|
| ① 받기 | `git clone https://github.com/Kim-MinSeok-Life/sueon.git` | 같음 |
| ② 폴더 이동 | `cd sueon` | 같음 |
| ③ **내 작업 브랜치로 이동** | `git switch tester2` (내 브랜치 이름) | 같음 |
| ④ 설치 | `npm.cmd ci` | `npm ci` |
| ⑤ 실행 | `npm.cmd run dev` → http://localhost:3001 | `npm run dev` |
| ⑥ 키포인트 복사(선택, 개발용) | `robocopy C:\tmp\sueon_share\sueon\data\keypoints data\keypoints /E` | `cp -R ~/Downloads/sueon_share/sueon/data/keypoints data/` |

> 받은 직후에는 `main`에 있습니다. ③에서 자기 브랜치로 옮긴 뒤 작업하세요(브랜치 배정은 7.1). 처음 `git switch tester2`를 치면 GitHub의 `tester2`를 자동으로 연결해 가져옵니다.
>
> 수어 동작 파일은 저장소에 들어 있어 ①~⑤만 하면 아바타가 움직입니다. ⑥은 리타기팅 실험(`retarget_vrm.py`)을 할 사람만, 팀 공유 ZIP을 `C:\tmp\sueon_share`(Mac은 다운로드의 `sueon_share`)에 풀었다고 가정한 경로입니다.

---

## 7. 브랜치 전략과 매일 작업 흐름

### 7.1 브랜치 구성

| 브랜치 | 역할 | 누가 쓰나 | 직접 커밋 |
|---|---|---|:---:|
| `main` | **최종본.** 저장소 첫 화면에 보이는 버전. `develop`에서 확인이 끝난 것만 들어옴 | — | ❌ |
| `develop` | **취합·확인.** 각자 작업을 모아 함께 실행·테스트하는 곳 | — | ❌ |
| `tester1` | 작업 브랜치 | `Kim-MinSeok-Life` | ✅ |
| `tester2` | 작업 브랜치 | `jhsong7907` | ✅ |

> 팀원이 늘면 `tester3`처럼 같은 방식으로 추가합니다(7.7).

```
main     ●─────────────────────────────────────●   최종본
          \                                   /
develop    ●──────────●──────────●───────────●     취합·확인
            \        /          /
tester1      ●──●───●          /                   작업 (Kim-MinSeok-Life)
              \               /
tester2        ●──●──●───────●                     작업 (jhsong7907)
```

### 7.2 흐름 한눈에 보기

| 순서 | 무엇을 | 어떻게 | 누가 |
|:---:|---|---|---|
| 1 | 작업 시작 전 최신 받기 | `git pull origin develop` (7.3) | 각자 |
| 2 | 내 브랜치에서 작업·커밋·올리기 | `git add` → `git commit` → `git push` (7.3) | 각자 |
| 3 | **내 브랜치 → `develop`** 으로 PR | `gh pr create --base develop` (7.4) | 각자 |
| 4 | PR 확인 후 `develop`에 합치기 | `gh pr merge --merge` (7.4) | 다른 팀원이 확인하고 합치기 권장 |
| 5 | `develop`에서 합친 결과 실행·테스트 | `npm.cmd test`, 브라우저 확인 (7.5) | 합친 사람 |
| 6 | **`develop` → `main`** 으로 PR·합치기 | 발표·보고서 전 등 정리된 시점에 (7.5) | 합의 후 |

### 7.3 매일 작업 (내 브랜치에서)

| 단계 | 명령 | 설명 |
|:---:|---|---|
| ① 내 브랜치인지 확인 | `git branch --show-current` | 내 브랜치(`tester1` 또는 `tester2`)가 나와야 함. 아니면 `git switch 내브랜치` |
| ② 최신 받기 | `git pull origin develop` | 남이 `develop`에 합친 내용을 내 브랜치로 가져옴. **작업 시작 전 매번** |
| ③ 작업 후 확인 | `npm.cmd test` (Mac은 `npm test`) → `git status` | 테스트 통과, 바뀐 파일 확인 |
| ④ 담기·저장 | `git add -A` → `git commit -m "[기능] 한 줄 설명"` | 메시지는 **한국어로**. 머리말은 아래 표 |
| ⑤ 올리기 | `git push` | 처음 한 번만 `git push -u origin tester1` |

**커밋 메시지 머리말**

| 머리말 | 뜻 | 예 |
|---|---|---|
| `[기능]` | 새 기능 추가 | `[기능] LLM 키 있을 때 분석 결과 표시` |
| `[수정]` | 버그 고침 | `[수정] 배 단어 뜻이 잘못 골라지는 문제` |
| `[문서]` | 문서만 바꿈 | `[문서] 브랜치 규칙 추가` |
| `[정리]` | 동작은 같고 코드 구조만 정리 | `[정리] 분석기 함수 나누기` |
| `[테스트]` | 테스트 추가·수정 | `[테스트] 가능 표현 테스트 추가` |
| `[설정]` | 설정·도구·패키지 | `[설정] 패키지 버전 올림` |

> **Windows IntelliJ 터미널에서 한글을 치면 멈출 때:** 터미널 대신 IntelliJ의 **커밋 창**을 쓰세요(한글 정상).
>
> | 단계 | 할 일 |
> |---|---|
> | ① | `Ctrl + K` (또는 왼쪽 세로 막대의 **Commit** 탭) |
> | ② | 올릴 파일에 체크 → 아래 칸에 한국어 메시지 입력 |
> | ③ | **Commit and Push...**(커밋하고 올리기) 클릭 → 다음 창에서 **Push**(올리기) |
>
> Mac 터미널은 한글이 그대로 됩니다.

### 7.4 PR로 `develop`에 합치기

| 단계 | 명령 | 설명 |
|:---:|---|---|
| ① PR 만들기 | `gh pr create --base develop --head tester1 --fill` | `--base` = 받는 쪽, `--head` = 보내는 쪽, `--fill` = 커밋 메시지로 제목·설명 채움 |
| ② PR 확인 | `gh pr view --web` | 바뀐 파일(Files changed)을 같이 봄 |
| ③ 합치기 | `gh pr merge --merge` | 일반 병합. **`--squash`와 `--delete-branch`는 쓰지 않음**(아래) |

> ⚠️ **웹에서 PR을 만들 때:** GitHub는 받는 쪽을 기본으로 `main`으로 잡습니다. 화면 위 **base: `main` ▾**를 **`develop`**으로 바꾸세요.
>
> ⚠️ **`--squash`를 쓰지 않는 이유:** `tester1`·`tester2`는 계속 쓰는 브랜치입니다. squash(커밋을 하나로 뭉쳐 합치기)를 하면 다음 PR 때 이미 합친 변경이 다시 나오거나 충돌합니다. **`--delete-branch`**는 내 브랜치를 지워 버리므로 쓰지 않습니다.

#### PR이란

| 용어 | 뜻 |
|---|---|
| **PR (Pull Request)** | "내 브랜치의 변경을 저 브랜치에 합쳐 주세요"라는 **요청서**. 바뀐 내용을 화면으로 보여 주고, 댓글로 의견을 남길 수 있음 |
| base | **받는 쪽** 브랜치 (우리 규칙: `develop`) |
| compare | **보내는 쪽** 브랜치 (내 `tester1`·`tester2`) |
| Merge | 요청을 받아들여 실제로 합치기 |
| Conflict | 두 사람이 같은 파일의 같은 줄을 다르게 고쳐서 자동으로 못 합치는 상태 |

#### 웹에서 PR 만들기·합치기 (`gh` 없이, 클릭만으로)

> GitHub 화면은 영어만 있습니다. 아래 표의 **굵은 영어**는 화면에 보이는 버튼 글자 그대로이고, 괄호 안이 뜻입니다.

**만들기 (작업한 사람)**

| 단계 | 할 일 |
|:---:|---|
| ① | 커밋 후 올리기(`git push` 또는 IntelliJ 커밋 창의 Commit and Push) |
| ② | 저장소 첫 화면 https://github.com/Kim-MinSeok-Life/sueon 열기 → 위쪽 노란 띠("tester2 had recent pushes" = tester2에 방금 올라온 게 있음)의 **Compare & pull request**(비교하고 PR 만들기) 클릭. 띠가 없으면 위쪽 **Pull requests** 탭 → **New pull request**(새 PR) |
| ③ | 화면 위쪽 두 칸 확인: **base**(받는 쪽) = `develop`, **compare**(보내는 쪽) = 내 브랜치. base가 `main`이면 눌러서 **`develop`으로 바꾸기** |
| ④ | 맨 위 칸에 제목, 큰 칸에 설명을 **한국어로** 쓰기(무엇을 바꿨는지) |
| ⑤ | **Create pull request**(PR 만들기) 클릭 |

**합치기 (다른 팀원이 확인 후)**

| 단계 | 할 일 |
|:---:|---|
| ① | 위쪽 **Pull requests** 탭 → 해당 PR 클릭 |
| ② | **Files changed**(바뀐 파일) 탭에서 내용 확인. 빨간 줄 = 지운 것, 초록 줄 = 추가한 것. 의견은 줄 옆 **+** 눌러 댓글 |
| ③ | **Conversation**(대화) 탭으로 돌아와 아래 초록 버튼 옆 **▾** → **Create a merge commit**(일반 병합) 선택. Squash·Rebase는 고르지 않기 |
| ④ | **Merge pull request**(합치기) → **Confirm merge**(합치기 확인) |
| ⑤ | 합친 뒤 나오는 **Delete branch**(브랜치 삭제)는 **누르지 않기** (`tester` 브랜치는 계속 씀) |
| ⑥ | 각자 터미널에서 `git pull origin develop`으로 합쳐진 내용 받기 |

> 초록 버튼 대신 "**This branch has conflicts**"(충돌 있음)가 보이면, 둘이 같은 곳을 고친 것입니다. 혼자 고치지 말고 팀원에게 화면을 공유해 같이 해결하세요(8절).

### 7.5 `develop` 확인 후 `main`으로

| 단계 | 명령 | 설명 |
|:---:|---|---|
| ① `develop`으로 이동·최신화 | `git switch develop` → `git pull` | 합쳐진 최신 상태 |
| ② 함께 확인 | `npm.cmd ci` → `npm.cmd test` → `npm.cmd run dev` | 두 사람 작업이 합쳐진 상태로 동작하는지 |
| ③ PR 만들기 | `gh pr create --base main --head develop --fill` | 최종 반영 요청 |
| ④ 합치기 | `gh pr merge --merge` | 저장소 첫 화면(README 포함)이 이 버전으로 바뀜 |
| ⑤ 내 브랜치로 돌아가기 | `git switch tester1` | `develop`·`main`에서 직접 작업하지 않음 |

### 7.6 지킬 규칙

| 규칙 | 이유 |
|---|---|
| `main`·`develop`에 직접 `git push` 하지 않기 | 확인 안 된 코드가 최종본에 섞이지 않게(5절 보호 규칙을 켜면 자동으로 막힘) |
| 작업 시작 전 `git pull origin develop` | 충돌을 작게 유지 |
| `git push --force` 쓰지 않기 | 다른 사람이 받은 이력이 깨짐 |
| 커밋 메시지·PR 제목은 한국어로, 머리말(`[기능]` 등) 붙이기 | 누가 무엇을 바꿨는지 한눈에 보이게. Windows 터미널에서 한글이 멈추면 IntelliJ 커밋 창 사용(7.3) |
| PR은 다른 팀원이 한 번 보고 합치기 | 실수를 서로 잡기 |

### 7.7 브랜치를 새로 만들 때 (처음 한 번, 저장소 관리자)

| 단계 | 명령 | 설명 |
|:---:|---|---|
| ① `main` 최신화 | `git switch main` → `git pull` | 출발점 맞추기 |
| ② 만들기 | `git branch develop` · `git branch tester1` · `git branch tester2` | 지금 위치에서 갈라지는 줄기를 만들기만 함 |
| ③ GitHub에 올리기 | `git push -u origin develop tester1 tester2` | 원격에도 생성, `-u`로 연결 |
| ④ 내 브랜치로 이동 | `git switch tester1` | |
| ⑤ 확인 | `git branch -a` | `remotes/origin/` 아래 4개(`main`, `develop`, `tester1`, `tester2`) |

> 2026-11-03에 위 순서로 `develop`·`tester1`·`tester2`를 만들어 두었습니다. 사이트에서는 https://github.com/Kim-MinSeok-Life/sueon/branches 에서 볼 수 있습니다.

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
| 내 브랜치 → develop PR | `gh pr create --base develop --head tester1 --fill` |
| develop → main PR | `gh pr create --base main --head develop --fill` |
| develop 최신 내용 받기 | `git pull origin develop` |
| PR 목록 / 상태 | `gh pr list` / `gh pr status` |
| 저장소 웹으로 열기 | `gh repo view --web` |
