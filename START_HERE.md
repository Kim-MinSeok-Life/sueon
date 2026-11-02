# SUEO:N 처음 실행하기 🙌

> [!TIP]
> GitHub에 올리기·팀 작업은 [`GITHUB_GUIDE.md`](GITHUB_GUIDE.md), 프로젝트 소개는 [`README.md`](README.md)를 보세요.
> IntelliJ에서는 편집 창 오른쪽 위 **Preview** 아이콘을 누르면 표가 정리된 모습으로 보여요.

| 걸리는 시간 | 준비물 | 주의 |
|---|---|---|
| 처음 약 10분 | Node.js 22 이상, 인터넷(처음 설치 때만) | 실험용이라 수어 정확성 미검수 · **외부 공개·재배포 금지** |

---

## ⚡ 한눈에 보기

| 단계 | Windows | Mac |
|:---:|---|---|
| 1 | [nodejs.org](https://nodejs.org)에서 **LTS** 설치 | 같음 |
| 2 | 받은 공유 ZIP 파일 오른쪽 클릭 → **압축 풀기** (GitHub에서 받았다면 생략) | ZIP 더블클릭 |
| 3 | `sueon` 폴더 **주소창**에 `powershell` 입력 → Enter | 터미널에서 `cd ` 입력 후 `sueon` 폴더를 끌어다 놓고 Enter |
| 4 | `npm.cmd ci` (처음 한 번, 1~2분) | `npm ci` |
| 5 | `npm.cmd run dev` | `npm run dev` |
| 6 | Chrome에서 http://localhost:3001 | 같음 |

`Local: http://localhost:3001` 이 보이면 성공이에요 🎉 · **터미널 창은 닫지 마세요** (닫으면 앱도 꺼져요).

---

## ✅ 이렇게 나오면 정상

| 입력해 보기 | 화면 |
|---|---|
| `택시 기본요금 얼마예요?` | "이렇게 이해했어요"에 **택시 · 기본 · 돈 · 얼마**, 아바타가 이어서 수어. 의문문이라 눈썹이 올라감 |
| `배를 탔어요` | **배(교통)** 로 뜻을 고름 |
| `골키퍼` | 단어 하나도 재생 |
| `안녕하세요` | "동작 없음" — 아직 동작 데이터가 없어서 정상 |

- **손동작 확대** 버튼으로 손을 크게 볼 수 있어요.
- **🎙 음성 입력**도 돼요 (마이크 권한 허용).

## ⏹ 끄기 / 다시 켜기

| 끄기 | 다시 켜기 |
|---|---|
| 앱을 켠 터미널에서 `Ctrl + C` | 4단계는 생략하고 5단계 명령만 |

---

## 💻 IntelliJ로 실행하기

<details>
<summary>펼치기</summary>

1. **File → Open** → `sueon` 폴더 **자체**를 선택 → **Trust Project**
2. 왼쪽 아래 **Terminal** 열기 (`Alt+F12`, Mac `⌥+F12`)
3. 줄 앞에 `...\sueon>`이 보이면 위 4·5단계 명령 입력
4. (Ultimate만) `package.json`의 `"dev"` 줄 왼쪽 **▶** 버튼 → **Run 'dev'** 로도 켤 수 있어요. 끌 때는 Run 창의 **■**

</details>

## ❓ Windows는 왜 `npm.cmd`인가요?

<details>
<summary>펼치기</summary>

PowerShell 보안 설정 때문에 `npm`만 입력하면 "스크립트를 실행할 수 없습니다" 오류가 날 수 있어요. `npm.cmd`는 이 설정과 상관없이 실행돼요.

</details>

---

## 🔧 안 될 때

| 이런 메시지·증상 | 이렇게 해 보세요 |
|---|---|
| (Windows) `이 시스템에서 스크립트를 실행할 수 없으므로…` | `npm` 대신 **`npm.cmd`** |
| `'npm'은(는) 인식되지 않습니다` / `command not found: npm` | Node.js 설치 후 터미널·IntelliJ를 **껐다 다시** 열기 |
| `ENOENT ... package.json` | `sueon` 폴더가 아닌 곳에서 실행함. 프롬프트에 **sueon**이 보이는지 확인 |
| `Port 3001 is in use` / `already running` | 이미 켜져 있어요. 그냥 http://localhost:3001 접속 |
| 화면이 404거나 옛날 화면 | 다른 폴더(이전 attempt)의 서버가 켜져 있음. 그 터미널에서 `Ctrl + C` 후 올바른 폴더에서 다시 |
| `npm ci` 중 오류 | 인터넷 확인 후 다시. 학교·회사망은 프록시 문제일 수 있음 |
| (Mac) `EACCES` 권한 오류 | 폴더를 다운로드·데스크탑으로 옮긴 뒤 다시. `sudo`는 쓰지 않기 |
| 아바타가 안 보여요 | 브라우저 **하드웨어 가속** 켜기, 최신 Chrome·Edge |
| 단어를 넣어도 안 움직여요 | `run dev`로 켰는지 확인 (`npm start` 운영 모드에서는 동작 파일을 일부러 막아 둠) |
| 🎙 음성 입력이 안 돼요 | 브라우저 마이크 권한 **허용** |

그래도 안 되면 터미널의 **빨간 오류 메시지 전체**를 캡처해서 개발 담당자에게 보내 주세요.

---

## 🔑 (선택) LLM API 키 넣기

키가 없어도 앱은 규칙 분석만으로 정상 동작해요. 키를 받았을 때만 하세요.

| 순서 | Windows | Mac |
|:---:|---|---|
| 1 | `copy .env.example .env.local` | `cp .env.example .env.local` |
| 2 | `.env.local`을 열어 쓸 줄의 맨 앞 `#`을 지우고 값을 채우기 | 같음 |
| 3 | 앱을 껐다(`Ctrl + C`) 다시 켜기 | 같음 |

- `.env.local`은 Git·ZIP에 **들어가지 않아요**(`.gitignore`). 다른 사람에게 보내지 마세요.
- **키를 실수로 커밋했다면** 발급한 사이트에서 즉시 폐기·재발급하세요. 이력에서 지우는 것만으로는 안전하지 않아요.

---

## 🧪 (선택) 개발자용

<details>
<summary>개발용 주소</summary>

| 주소 | 용도 |
|---|---|
| http://localhost:3001/?debug=1 | 관절 테스트 도구 |
| http://localhost:3001/?debug=1&skeleton=1 | 원본 3D 관절(빨간 선)을 아바타 위에 겹쳐 보기 |
| http://localhost:3001/compare | 원본 영상과 아바타 비교 검수 (`alhub_data/`에 원본 영상 ZIP + `python scripts/build_video_compare.py` 한 번 필요) |

</details>

<details>
<summary>자동 테스트 (모두 통과하면 정상)</summary>

| Windows | Mac |
|---|---|
| `npm.cmd test` | `npm test` |
| `npm.cmd run typecheck` | `npm run typecheck` |
| `npm.cmd run build` | `npm run build` |

</details>

더 자세한 내용: [`README.md`](README.md) · [`ARCHITECTURE.md`](ARCHITECTURE.md)
