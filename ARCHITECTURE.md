# SUEO:N(수어온) — 아키텍처·설계·원리

| 대상 | 다루는 것 | 다루지 않는 것 |
|---|---|---|
| 개발자 | 무엇이 **어디서 어떻게** 동작하는가 | 사용법 → [`START_HERE.md`](START_HERE.md), 소개 → [`README.md`](README.md) |

## 목차

| 절 | 내용 | 절 | 내용 |
|---|---|---|---|
| [1](#1-기술-스택) | 기술 스택 | [5](#5-핵심-알고리즘) | 핵심 알고리즘 (분석기·리타기팅·재생·비교·LLM·표정) |
| [2](#2-전체-흐름) | 전체 흐름 | [6](#6-보안배포-게이트) | 보안·배포 게이트 |
| [3](#3-디렉터리) | 디렉터리 | [7](#7-도구명령) | 도구·명령 |
| [4](#4-데이터-형식) | 데이터 형식 | [8](#8-확장-지점) | 확장 지점 |

---

## 1. 기술 스택

| 영역 | 기술 (버전) | 쓰임 |
|---|---|---|
| 웹앱 | Next.js 16.4.1 (App Router, Turbopack), React 19.2.9, TypeScript 5.9.3 | 화면, API 라우트, 프록시(운영 차단) |
| 3D | Three.js 0.186.1, @pixiv/three-vrm 3.5.5 | VRM 1.0 아바타 렌더링, 정규화 본 회전 |
| 데이터 처리 | Python 3.13 + numpy | AI-Hub ZIP 파싱, 리타기팅, 사전·동작 라이브러리 생성 |
| 테스트 | `node --test`(TS strip-types), Python `unittest` | 분석기·형태소·수학·리타기팅 |
| 실행 | Node 22+ (개발 환경 24.21), 포트 3001 고정(`next dev -p 3001`) | |
| 브라우저 API | Web Speech API(음성 인식), speechSynthesis(TTS) | 브라우저 내장 |
| LLM(선택) | @anthropic-ai/sdk 1.3.0, OpenAI Chat Completions(fetch) | 문장 → 수어 단어 후보. 키 없으면 비활성 |

> ⚠️ **Next.js 16은 학습 데이터의 Next와 다르다.** 코드를 쓰기 전에 `node_modules/next/dist/docs/`를 확인한다(`AGENTS.md`).
>
> | 바뀐 점 | 내용 |
> |---|---|
> | Route Handler | `params`는 Promise |
> | 미들웨어 | `src/proxy.ts` (proxy 규약) |

---

## 2. 전체 흐름

### 2.1 앱 (브라우저)

| 순서 | 위치 | 하는 일 |
|:---:|---|---|
| 1 | 사용자 | 한국어 입력 / 음성(Web Speech → 텍스트) |
| 2 | `SignTranslator.tsx` | 시작 시 `/motions/aihub_gloss/index.json` + `/ksl/dictionary.json` 로드 → `buildLexicon()`. `#`로 시작하면 옛 매처(`matcher.ts`, 개발 명령: `#WORD1502`, `#SEN0038`) |
| 3 | `planner.ts` | `planSentence(text, lexicon)` → `SignPlan` (규칙, 아래 7단계) |
| 3-1 | `llm.ts` (LLM 켜짐일 때만) | `POST /api/analyze` → LLM 후보 → `verifyCandidate(후보, lexicon, 규칙 계획)` → 통과면 `source:"llm"` 계획, 아니면 규칙 계획(+검증 기록). 키 없음·8초 초과·오류 → 규칙 계획 |
| 4 | `motion.ts` | playable 토큰 → `loadClipForEntry()` → `validateClip()` |
| 5 | `MotionPlayer.ts` | `load(clips)`: 리드인 → 핵심 구간 재생 → 다음 단어 → 복귀 |
| 6 | `AvatarStage.tsx` | Three.js 렌더 루프: `player.update(dt)` → 표정(의문문 근사) → `vrm.update()` (정규화 본 → 스킨 본) |

**planner 7단계**

| 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|
| 정리 (군말·반복·더듬음) | 형태 분석 (조사·겹조사·활용·하다 용언·복합명사·보조용언) | 오타 교정 (동작 있는 단어만, 자모 거리) | 의미 선택 (국립국어원 분류+문맥) | 동작 연결 (동작의 뜻 ≠ 입력의 뜻이면 재생 안 함) | KSL 어순 | 확신도 |

<details>
<summary>흐름도 (원본 그림)</summary>

```
[사용자] 한국어 입력 / 음성(Web Speech → 텍스트)
   │
   ▼
SignTranslator.tsx ── 시작 시 /motions/aihub_gloss/index.json + /ksl/dictionary.json 로드 → buildLexicon()
   │  '#'로 시작하면 옛 매처(matcher.ts, 개발 명령: #WORD1502, #SEN0038)
   ▼
planner.ts  planSentence(text, lexicon) → SignPlan (규칙)
   │  LLM 켜짐(서버에 키)이면: POST /api/analyze → LLM 후보 → llm.ts verifyCandidate(후보, lexicon, 규칙 계획)
   │  → 검증 통과면 source:"llm" 계획, 아니면 규칙 계획(+검증 기록). 키 없음·8초 초과·오류 → 규칙 계획
   1 정리(군말·반복·더듬음) → 2 형태 분석(조사·겹조사·활용·하다 용언·복합명사·보조용언)
   → 3 오타 교정(동작 있는 단어만, 자모 거리) → 4 의미 선택(국립국어원 분류+문맥)
   → 5 동작 연결(동작의 뜻 ≠ 입력의 뜻이면 재생 안 함) → 6 KSL 어순 → 7 확신도
   │
   ▼
playable 토큰 → loadClipForEntry() → validateClip() → MotionPlayer.load(clips)
   │                                                     (리드인 → 핵심 구간 재생 → 다음 단어 → 복귀)
   ▼
AvatarStage.tsx  Three.js 렌더 루프: player.update(dt) → 표정(의문문 근사) → vrm.update()  (정규화 본 → 스킨 본)
```

</details>

### 2.2 오프라인 파이프라인 (개발자 PC, Python)

| 입력 | 도구 | 출력 |
|---|---|---|
| AI-Hub ZIP(키포인트·형태소) | `aihub_keypoints.py` (파싱·검사·mm→m) | 발췌 키포인트 |
| 발췌 키포인트 + `avatar.vrm`(T-포즈 뼈 위치) + `data/avatar_body_front.json` | `retarget_vrm.py` | `sueon-keyframes/v1` JSON |
| 위 결과 | `build_gloss_library.py` | `public/motions/aihub_gloss/` |
| 국립국어원 CSV | `build_ksl_dictionary.py` | `public/ksl/dictionary.json` |
| 영상 ZIP + 형태소 | `build_video_compare.py` | `data/video_compare.json` → `/compare` (개발 전용) |

<details>
<summary>파이프라인 그림 (원본)</summary>

```
AI-Hub ZIP(키포인트·형태소) ─ aihub_keypoints.py(파싱·검사·mm→m) ─┐
                                                                   ├→ retarget_vrm.py ─→ sueon-keyframes/v1 JSON
avatar.vrm(T-포즈 뼈 위치) + data/avatar_body_front.json ──────────┘        │
                                                         build_gloss_library.py → public/motions/aihub_gloss/
국립국어원 CSV → build_ksl_dictionary.py → public/ksl/dictionary.json
영상 ZIP + 형태소 → build_video_compare.py → data/video_compare.json → /compare (개발 전용)
```

</details>

---

## 3. 디렉터리

**화면·API (`src/app`)**

| 경로 | 역할 |
|---|---|
| `src/app/page.tsx` | 메인(SignTranslator) |
| `src/app/compare/page.tsx` | 원본 영상 ↔ 아바타 비교 검수(개발 전용, 운영 빌드에선 안내문만) |
| `src/app/api/aihub-video/` | 비교표 목록 + ZIP 안 mp4 구간 스트리밍(Range, 운영 404) |
| `src/app/api/analyze` | LLM 후보(GET 사용 가능 여부, POST 후보). 키 없으면 503, 운영 기본 차단 |
| `src/app/api/transcribe` | 선택형 OpenAI 음성 전사(키 없으면 503, 운영 기본 차단) |

**컴포넌트·라이브러리 (`src`)**

| 경로 | 역할 |
|---|---|
| `src/components/SignTranslator.tsx` | 입력·음성·분석 결과·확인 안내·재생 제어·TTS 답변 |
| `src/components/AvatarStage.tsx` | VRM 로딩, 카메라(상반신/손 확대), 렌더 루프, 디버그 훅(`?debug=1`) |
| `src/lib/ksl/planner.ts`, `hangul.ts` | 문장 분석기, 한글 자모 유틸 |
| `src/lib/ksl/llm.ts` | LLM 프롬프트·응답 정리·규칙 검증(공급자 무관, 브라우저·서버 공용) |
| `src/lib/ksl/llmProviders.ts` | LLM 공급자 연결(서버 전용: anthropic / openai / mock) |
| `src/lib/MotionPlayer.ts` | 키프레임 재생기 |
| `src/lib/motion.ts`, `types.ts` | 클립 검증·로딩, 데이터 타입 |
| `src/lib/matcher.ts` | 옛 사전 매처(`#` 명령, 등록 표현) |
| `src/lib/poseSafety*.ts` | 초기 손목·몸통 근사 보정(`AIHUB-SAMPLE-*` 옛 동작에만 적용) |
| `src/lib/SkeletonOverlay.ts` | 원본 관절 겹쳐 보기(`?debug=1&skeleton=1`) |
| `src/proxy.ts` | 운영 모드에서 AI-Hub 파생 동작 경로 403 |

**데이터 (`public`, `data`)**

| 경로 | 내용 | Git |
|---|---|:---:|
| `public/models/avatar.vrm` | 아바타(VRM 1.0, 휴머노이드 본 54, 손가락 30) | ✅ |
| `public/motions/aihub_gloss/` | 수어 단어 동작 1,351(문장 속 `g…` 317 + 단어 영상 `w…` 785 + 지문자 `f…` 249) + `index.json` — AI-Hub 파생 | ✅ |
| `public/motions/aihub_real02/` | 단어 단독 9 + 원본 관절 오버레이 — AI-Hub 파생 | ✅ |
| `public/motions/sample`, `stabilized` | 초기 근사 동작(비교용) | ✅ |
| `public/motions/test/` | 관절 테스트 동작 2(수어 아님) | ✅ |
| `public/ksl/dictionary.json` | 국립국어원 사전 3,734 항목(뜻 분류·수형 설명) | ✅ |
| `data/expressions.json` | 등록 표현(단어 예시·`#`명령용) | ✅ |
| `data/aihub_morphemes.json`, `data/morphemes/` | 단어·문장 형태소 원본/요약 | ✅ |
| `data/avatar_body_front.json` | 아바타 몸·머리 앞면 깊이 격자 + 머리 기준점 | ✅ |
| `data/keypoints/` | 발췌 키포인트(테스트용, 재배포 금지) | ❌ |
| `data/video_compare.json` | 비교표(로컬 ZIP 위치) | ❌ |

**그 밖**

| 경로 | 내용 |
|---|---|
| `scripts/` | Python·Node 도구([7절](#7-도구명령)) |
| `tests/` | Node·Python 테스트 |
| `reports/` | 측정 리포트·빌드 로그 |

---

## 4. 데이터 형식

| 형식 | 파일 | 한 줄 설명 |
|---|---|---|
| [`sueon-keyframes/v1`](#41-동작-클립-sueon-keyframesv1) | 동작 클립 JSON (`src/lib/types.ts`) | 본별 쿼터니언 키프레임 + 리타기팅 메타 |
| [`sueon-gloss-library/v1`](#42-동작-사전-sueon-gloss-libraryv1) | `public/motions/aihub_gloss/index.json` | gloss → 클립 경로·문맥 |
| [`sueon-ksl-dictionary/v1`](#43-사전-sueon-ksl-dictionaryv1) | `public/ksl/dictionary.json` | 국립국어원 사전 항목 |
| [몸 앞면](#44-몸-앞면-dataavatar_body_frontjson) | `data/avatar_body_front.json` | 관통 방지용 깊이 격자 |
| [AI-Hub 원본 규칙](#45-ai-hub-원본-규칙-실측) | ZIP 안 JSON | 파일명·좌표계·단위 |

### 4.1 동작 클립 `sueon-keyframes/v1`

```json
{ "format":"sueon-keyframes/v1", "motion_id":"AIHUB-REAL02-GLOSS-g0012", "kind":"test",
  "space":"vrm-normalized-humanoid", "duration":1.2, "label":"[택시] · …",
  "keyframes":[{"t":0,"bones":{"rightUpperArm":[x,y,z,w], …}}, …],
  "retarget":{"take":"NIA_SL_SEN…_REAL02_F","fps":30,"source_frames":[i0,i1],
              "gloss":"택시","gloss_segments":[["택시",0.15,1.05]],"source_sentence":"…",
              "penetration_after_cm":{…},"head_offset_cm":{…},"head_scale":[kx,ky,kz]}}
```

| 항목 | 설명 |
|---|---|
| 쿼터니언 `[x,y,z,w]` | VRM **정규화 본** 로컬 회전. 항등은 T-포즈이고 축은 월드와 정렬된다. 아바타는 +Z를 바라본다 |
| `kind: "test"` | 한국수어로 검증되지 않았기 때문. `ksl`로 올리려면 사람 검수가 필요하다 |
| 프레임 | 30fps 전 프레임(촘촘함) → 플레이어가 등속 보간·리드인 모드로 재생한다 |

### 4.2 동작 사전 `sueon-gloss-library/v1`

`items[gloss] = {id, path, source_take, segment_sec, position, duration, occurrences, nonmanual, penetration_after_cm, context[]}`

| 필드 | 설명 |
|---|---|
| `context` | 원래 문장의 다른 gloss. 동작의 뜻(동음이의어)을 정하는 데 쓴다 |

### 4.3 사전 `sueon-ksl-dictionary/v1`

`entries[] = {id, w, c, d, h, j}` — 영상이나 동작은 없다.

| 필드 | 뜻 |
|---|---|
| `id` | 수어사전 번호 |
| `w` | `[[단어, 괄호문맥?]…]` |
| `c` | `"대분류 > 소분류"` |
| `d` | 일상어 여부 |
| `h` | 수형 설명 |
| `j` | (원본 필드) |

### 4.4 몸 앞면 `data/avatar_body_front.json`

| 항목 | 값 |
|---|---|
| 몸 | x ±0.16, y 0.8~1.6, 4cm 격자. 정면에서 광선을 쏴 측정한 몸 표면 z |
| `head` | 2cm 격자로 얼굴과 1.38m 위 머리카락을 포함 |
| `landmarks` | 눈 높이 1.449, 귀 반폭 0.10, 귀 z -0.035, 코끝 (0, 1.40, 0.0825), 턱 1.36, 정수리 1.60 |
| 측정 방법 | `window.__SUEON__.raycastFront(x,y)` (`?debug=1`) |

### 4.5 AI-Hub 원본 규칙 (실측)

| 항목 | 규칙 |
|---|---|
| 파일명 | `NIA_SL_{WORD\|SEN}{4자리}_{REAL\|SYN\|CROWD}{2자리}_{F\|U\|D\|L\|R}_{프레임12자리}_keypoints.json` / `..._morpheme.json`. 경로가 아니라 파일 이름(basename)으로 해석한다 |
| JSON 구조 | `people`은 객체다. 3D는 몸 25×4, 손 21×4×2, 얼굴 70×4 |
| 좌표계 | F 카메라 좌표계(x 오른쪽, y 아래, z 깊이). 5개 카메라의 3D 값이 동일하므로 F만 쓴다 |
| 단위 | 일부 촬영본은 mm 단위(\|z\| 중앙값 > 100이면 mm). 신뢰도 값은 모두 1 |
| 형태소 | `{metaData:{duration,…}, data:[{start,end,attributes:[{name:gloss, attribute:[비수지]}]}]}` |
| 결합 조건 | **같은 ID + 같은 촬영자 + 같은 카메라**일 때만. 길이 차이가 0.1초 넘으면 제외 |

---

## 5. 핵심 알고리즘

| 절 | 대상 | 방식 | 상태 |
|---|---|---|---|
| [5.1](#51-문장-분석기-plannerts-규칙) | 문장 분석기 `planner.ts` | 규칙 | 동작 |
| [5.2](#52-리타기팅-retarget_vrmpy-수학) | 리타기팅 `retarget_vrm.py` | 수학 | 동작 |
| [5.3](#53-재생기-motionplayerts) | 재생기 `MotionPlayer.ts` | 보간 | 동작 |
| [5.4](#54-비교-검수-compare) | 비교 검수 `/compare` | 개발 전용 | 동작 |
| [5.5](#55-llm-판단-계층-llmts-llmprovidersts-apianalyze) | LLM 판단 계층 | 외부 LLM + 규칙 검증 | 6.1, **실제 호출 미검증** |
| [5.6](#56-의문문-표정-근사-avatarstagetsx) | 의문문 표정 | 규칙 근사 | 6.1, **미검증** |

### 5.1 문장 분석기 (`planner.ts`, 규칙)

| 단계 | 함수 | 규칙 |
|---|---|---|
| 사전 구성 | `buildLexicon` | 동작 gloss, 단어 예시, 사전 단어를 모아 명사 집합과 용언 어간 변이형(`predicateStems`)을 만든다. 어간 변이형은 하다/ㅂ/ㄷ/ㅅ/ㄹ/르 불규칙과 과거형을 포함한다(예: 타다→탔, 춥다→추워). 동작마다 원래 문장 문맥으로 사전 뜻(`senseId`)을 붙인다. 단서가 없으면 교통 영역을 우선한다 |
| 형태 분석 | `parseExact` | ① 숫자+단위 ② 짧은 명사+흔한 조사 우선("배가" = 배+가, 倍加 아님) ③ 명사+조사·하다류 / 어간+어미 후보를 비교. **하다 용언 우선**: 명사 뒤가 하/해/되…이고 그 용언이 사전에 있으면 용언(전하기→전하다, 위해→위하다). 명사와 용언 중 동작이 있는 쪽을 고른다 |
| 복합명사 | `parseCompound` | 앞 명사가 2음절 이상일 때 나눈다(기본요금→기본+요금) |
| 오타 | `parseFuzzy` | 조사·어미를 뗀 핵심부와 사전 단어의 자모 편집 거리(≤1, 4음절 이상은 ≤2). **동작이 있는 단어만** 후보 |
| 유의어 | — | 동작 없는 말을 AI-Hub 문장에서 같은 뜻으로 쓴 동작 단어로(요금→돈, 역·정류장→곳, 이후·뒤→후, 어떻게→방법) |
| 부정 | — | 안/못/않다를 처리하고 부정 표지를 동사 뒤에 둔다. "안 돼요"는 '안되다' 동작으로 |
| 의미 선택 | `chooseSense` | 일상어 뜻 우선. 점수: 사전 괄호 문맥 단서 +3, 분류별 단서 단어 +2, 대표 표기 +0.3, 영역 +1. 단서가 없으면 동작의 뜻을 기본값으로 쓰되, 단어 하나만 입력했으면 확인한다 |
| 동작 연결 | `findMotion` | 직접 일치 먼저. X하다/되다/나다/시키다는 명사 동작을 빌려 쓰되 **사전 큰 분류가 같을 때만**. 동작의 senseId와 입력의 뜻이 다르면 재생하지 않는다 |
| 가능/불가능 | — | 'ㄹ 수 있다/없다'(탈 수 있어요)는 의존명사 '수'를 따로 보지 않고 수어 '가능/불가능'으로 |
| 어순 | `orderTokens` | 시간어(오늘·밤·N시)는 앞, 의문사(무엇·어디·얼마·방법)는 뒤, 부정은 동사 뒤. 의문 종류는 `wh`/`yesno`로 표시하고 재생 중 표정 근사에 쓴다([5.6](#56-의문문-표정-근사-avatarstagetsx)) |
| 확신도 | — | 모르는 말 → low, 오타나 애매한 말 → medium. `needsConfirm`이면 화면에 안내. **동작 있는 단어는 그대로 재생** |

### 5.2 리타기팅 (`retarget_vrm.py`, 수학)

| 순서 | 단계 | 내용 |
|:---:|---|---|
| 1 | `load_rest` | avatar.vrm(glb)의 glTF 노드를 읽어 휴머노이드 본의 T-포즈 월드 위치와 손가락 끝 위치를 구한다 |
| 2 | `prepare` | 축 변환 (x,−y,−z): X축 180° 회전이며 거울 반전이 아니다. 몸통 좌표계 정규화: 어깨선 = X, 목−골반 = Y, 원점 = 목. 손 깊이 오류 보정(`fix_hand_depth`, 카메라 광선 방향)과 가우시안 평활(σ=1프레임) |
| 3 | `Retargeter.frame` | 아래 표 |
| 4 | 머리 비율 보정 `head_offsets` | 아래 표 |
| 5 | 관통 방지 | 아래 표 |
| 6 | 자르기 | 형태소 구간으로 자른다(앞뒤 0.15~0.2초) → 쿼터니언 부호 연속화 → `build_clip` |
| — | 정량 검사 | 순기구학으로 뼈 방향을 원본과 비교(`evaluate`). 관통 깊이는 `penetration`으로 잰다 |

**3 `Retargeter.frame`**

| 부위 | 방법 |
|---|---|
| upperChest | 어깨선 기울기의 60%만 반영 |
| 팔 | 손목 **2-본 IK**로 손목 목표를 정한다. 목표 = 아바타 어깨 중점 + (촬영자 점 − 촬영자 어깨 중점) × (아바타/촬영자 어깨폭) + 머리 보정 + 앞쪽 오프셋. 팔꿈치 굽힘면은 원본을 따른다 |
| 아래팔·손 | **방향 + 엄지쪽 축 정렬**로 비틀림(회내·회외)까지 회전 |
| 손가락 | 마디별 방향을 부모 좌표계로 옮겨 최소 회전(굽힘 + 벌림) |

**4 머리 비율 보정 `head_offsets`**

| 항목 | 식·값 |
|---|---|
| 기준점 q | 손 21점 중 머리 기준점(귀 중점의 x·z, 눈 높이 y)에 가장 가까운 점 |
| head_map(q) | 아바타 머리 기준점 + 상대위치 × k |
| k_x = k_y | 아바타 귀 반폭 / 촬영자 귀 반폭 (약 1.25~1.3) |
| k_z | 코 돌출 비율(코끝까지만 적용, 그보다 앞은 k_x) |
| 보정량 | w × (head_map − body_map). w는 거리 14cm 이내 1, 26cm 이상 0, 그 사이는 smoothstep |

**5 관통 방지**

| 항목 | 값 |
|---|---|
| 대상 | 아래팔과 손가락 점이 몸·머리 앞면보다 뒤에 있으면 피한다 |
| 간격 | 몸통 2.5cm, 얼굴 근처 0.8cm |
| 피하는 방향 | 손목이 배꼽(0.98m) 아래나 1.32m 위면 옆(±X)을 먼저, 그 외에는 앞(+Z) |
| 기본 앞으로 빼기 | 5cm × (1 − 머리 가중치) |
| 평활 | ±3프레임 최대 필터 후 σ=2, 최대 4회 반복 |

### 5.3 재생기 (`MotionPlayer.ts`)

| 항목 | 동작 |
|---|---|
| 클립 준비 | 본별 트랙으로 바꾸고, 키프레임 간격이 0.05초 이하면 촘촘한 클립(`dense`) |
| 촘촘한 클립 | 리드인(단독 0.3초, 문장 첫 단어 0.35초, 단어 사이 0.2초) 동안 시간은 멈추고 직전 자세에서 첫 자세로 slerp. 그 뒤 섞지 않고 재생, 키프레임 사이는 등속 slerp |
| 문장 연속 재생 | 문장에서 잘라 낸 단일 gloss 클립은 핵심 구간(`gloss_segments` ±0.05초)만 재생 |
| 듬성한 수작업 클립(테스트 동작) | 기존 방식: BLEND_IN 0.3~0.45초 섞기 + smoothstep |
| 끝 | 0.5초 동안 기본 자세로 복귀 |
| 제어 | `setSpeed()` 재생 속도, `seek()` 디버그 시각 |
| PoseSafety | `AIHUB-SAMPLE-*`(옛 근사 동작)에만 적용 |

### 5.4 비교 검수 (`/compare`)

| 부분 | 동작 |
|---|---|
| `build_video_compare.py` | 단어마다 영상을 고른다. 같은 촬영자 → 다른 촬영자 순, 정면 우선. 무압축 ZIP 항목의 데이터 시작 바이트(로컬 헤더 30바이트 + 이름 + extra)를 기록 |
| `/api/aihub-video/[take]` | 기록된 위치를 `fs.createReadStream(start,end)`로 바로 읽어 보낸다. Range 206 지원. 비교표에 없는 이름과 운영 모드는 거부 |
| 화면 — 시간 맞추기 | 아바타 시각 = `cs + (영상시각 − vs) × (ce−cs)/(ve−vs)`(단어 구간 직선 대응). 같은 촬영자면 1:1. 매 화면 `player.seek()`로 맞추므로 느린 재생도 동기화 |
| 화면 — 미리 받기 | 이전·다음 영상(브라우저 캐시 1시간) |
| 화면 — 판정 | 아바타 = 원본?, 원본 = 국립국어원? + 메모를 localStorage에 저장하고 JSON으로 내보낸다 |

### 5.5 LLM 판단 계층 (`llm.ts`, `llmProviders.ts`, `/api/analyze`)

> 6.1에서 추가. **실제 API 호출은 아직 미검증**(키 없음).

**공급자 선택** `getLlmProvider(env)` — `SUEON_LLM_PROVIDER`가 anthropic/openai/mock이면 그것, 비우면 `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` 순. 키가 없으면 null.

| 공급자 | 호출 | 기본 모델 | 설정 |
|---|---|---|---|
| anthropic | 공식 SDK `client.beta.messages.create` | `claude-opus-5-5` | `output_config.effort: "low"`, `fallbacks: "default"`(beta `server-side-fallback-2026-07-01`), `stop_reason: "refusal"`이면 실패 처리 |
| openai | Chat Completions | `gpt-4o-mini` | `response_format: json_object` |
| gemini | Gemini의 OpenAI 호환 주소(`generativelanguage.googleapis.com/v1beta/openai`) | `gemini-3.5-flash-lite` | Google AI Studio 무료 등급. 2026-11-05 실측: `gemini-2.5-flash`·`2.5-flash-lite`는 새 계정 404, `gemini-3.8-flash`·`3.7-flash`는 혼잡(503)·20초 초과, `3.5-flash-lite`·`3.1-flash-lite`는 약 2초. `reasoning_effort: low`. JSON 모드를 거부(400)하면 JSON 모드 없이 재요청. 실패 시 상태·응답 앞 300자를 서버 로그에 남김(키 제외) |
| mock | 준비된 답 | — | 개발 모드 전용 |

**프롬프트·응답**

| 함수 | 규칙 |
|---|---|
| `buildSystemPrompt(allowed)` | 기본형만, 동작 있는 단어(1,351개) 우선, 고유명사는 `fingerspell`, 어순 규칙, 동음이의어는 `sense` 분류 한 단어. 출력 JSON `{glosses:[{word,sense?,fingerspell?}], question, negation, note}` |
| `parseCandidate` | 첫 JSON 객체만, 한글·숫자 단어만, 최대 20단어·단어 20자 |

**검증** `verifyCandidate(input, cand, lex, rulePlan)`

| 순서 | 검사 | 버리는 기준 |
|:---:|---|---|
| 1 | 사전·동작에 없는 말은 버린다(지문자 표시는 허용) | 버린 말이 절반 이상이면 후보 전체 |
| 2 | 입력 근거: 규칙 기본형·교정 결과에 있거나, 입력에 어간이 있거나, 첫 글자 초·중성이 같거나(탔→타다), 대명사(저→나) | 근거 없는 말이 1/3 초과 |
| 3 | 규칙이 찾은 동작 단어를 뺐는가 | 절반 넘게 뺌(2개 이상일 때) |
| 4 | 뜻 힌트가 사전 분류 문자열에 들어 있으면 그 뜻으로. 동작의 senseId와 다르면 재생 안 함 | 맞지 않는 힌트는 무시 |
| 5 | `orderTokens`로 어순 재적용(같은 그룹 안에서는 LLM 순서 유지). 부정은 규칙과 같이 동사 뒤 부정 수어 하나 | — |
| — | 확신도 | 버림·근거 없음·누락·애매함이 하나라도 있으면 medium, 모르는 말이 있으면 low |

**화면** (`SignTranslator.analyze`): 처음 GET으로 사용 가능 여부 확인 → 가능할 때만 POST(8초 제한). 결과에 `source`와 `llmNotes`(검증 기록)를 보여 준다.

### 5.6 의문문 표정 근사 (`AvatarStage.tsx`)

> 6.1에서 추가. **미검증**, 얼굴 키포인트에서 옮긴 값이 아니다.

| 의문 종류 | VRM 표정 | 가중치 | 의도 |
|---|---|---|---|
| `yesno` | `surprised` | 0.45 | 눈썹 올림 |
| `wh` | `angry` | 0.35 | 눈썹 모음 |

| 항목 | 내용 |
|---|---|
| 아바타 표정 | 기본 18개(눈썹 전용 없음) → `QUESTION_EXPRESSION` |
| 적용 시점 | 렌더 루프에서 재생·일시정지 중일 때만 목표값으로 초당 3씩 바꾸고, 끝나면 0으로 |

---

## 6. 보안·배포 게이트

| 장치 | 동작 |
|---|---|
| `src/proxy.ts` | 운영(`NODE_ENV=production`)에서 `/motions/{sample,stabilized,aihub_real02,aihub_gloss}`를 403. 예외는 `NEXT_PUBLIC_SUEON_ALLOW_SAMPLE_PUBLIC=true`뿐이며, 켜려면 권리 확인 필요 |
| `/api/aihub-video*`, `/compare` | 운영에서 404 또는 안내문만 |
| `/api/analyze`, `/api/transcribe` | 키가 없으면 503. 운영에서는 `SUEON_ENABLE_PAID_API_PUBLIC=true`가 아니면 차단. `/api/analyze` GET은 사용 가능 여부·공급자 이름만 알려 주고 키 값은 보내지 않는다 |
| `.gitignore` | AI-Hub 원본·발췌 키포인트·비교표·참고 문서(PDF·PPTX·DOCX·CSV)·`.env*`·IDE 개인 설정 제외. 파생 동작(`public/motions/*`)은 2026-11-02부터 **포함**(2026-11-03 공개 저장소) |
| `scripts/make_release_zip.py` | node_modules·.next·원본 폴더(alhub_data 등)·참고 문서·비밀 설정을 빼고 묶는다. 루트의 `개발자참고.pdf`만 PDF 예외. ZIP은 프로젝트 밖 경로에 |

---

## 7. 도구·명령

| 명령 | 하는 일 |
|---|---|
| `npm.cmd run dev` / `build` / `start` | 개발 서버(3001) / 운영 빌드 / 운영 실행(3001) |
| `npm.cmd test` | Node 테스트(planner, llm, morphemes, matcher, poseSafetyMath) |
| `npm.cmd run test:py` | Python 테스트(파서·회전 수학·IK·관통·머리 비율·형태소 자르기) |
| `npm.cmd run typecheck`, `data:validate` | 타입 검사, 데이터 구조 검사 |
| `python scripts/aihub_keypoints.py report\|extract …` | ZIP 검사 리포트 / 촬영본 발췌(mm→m) |
| `python scripts/retarget_vrm.py <발췌.json> [--morphemes …]` | 단일 촬영본 → 동작 + 정량 비교 |
| `python scripts/build_gloss_library.py <sen_keypoint.zip> <sen_morpheme.zip> --actor 02` | 동작 사전 재생성(약 7분). `index.json`을 새로 쓰므로 **이어서 아래 단어 영상·지문자 명령도 다시 실행** |
| `python scripts/add_word_glosses.py <word_keypoint.zip> <word_morpheme.zip> --actor 02` | 단어 영상 동작(`w…`) 추가(약 10분). 문장 동작이 없는 사전 일상어·시연 단어만. `--dry-run`은 고를 단어만 출력 |
| `python scripts/add_fingerspell_glosses.py <crowd_keypoint.zip> <crowd_morpheme.zip>` | 지문자·지숫자 동작(`f…`) 추가(약 1시간). 숫자·숫자+단위·역/명소 이름만(도로명 제외). 2D 좌표를 `lift_2d.py`로 3D 복원 후 리타기팅. `--only 사당 5`로 일부만 시험 |
| `python scripts/lift_2d.py build-ref\|validate <samples.json>` | 2D→3D 복원 기준값(`scripts/lift_ref.json`) 만들기 / REAL02 3D와 비교 검증 |
| `python scripts/build_ksl_dictionary.py <CSV>` | 사전 JSON |
| `python scripts/build_video_compare.py [--root 폴더]` | 비교표 |
| `python scripts/make_release_zip.py <밖경로.zip>` | 공유 ZIP(파생 동작 + 발췌 키포인트, 팀 내부용) |
| `python scripts/make_release_zip.py <밖경로.zip> --github` | GitHub용 ZIP(.gitignore 기준: 파생 동작 포함, 원본·발췌 키포인트 제외) |
| `python scripts/validate-morphemes.py`, `validate-avatar.py` | 형태소·아바타 구조 검사 |

**디버그 주소**

| 주소 | 용도 |
|---|---|
| `/?debug=1` | 관절 도구, `window.__SUEON__` 훅 |
| `/?debug=1&skeleton=1` | 원본 관절 겹쳐 보기 |
| `/?debug=1&legacy=1` | 옛 변환 |
| `/compare` | 비교 검수 |

---

## 8. 확장 지점

| 영역 | 지금 | 다음에 할 방법 |
|---|---|---|
| LLM 계층 | 구조는 [5.5](#55-llm-판단-계층-llmts-llmprovidersts-apianalyze)에 완성 | 새 공급자는 `LlmProvider.complete(system, user, signal)` 하나만 구현해 `getLlmProvider`에 추가. 검증 기준은 `verifyCandidate` 안의 비율(1/2, 1/3)로 조정 |
| 표정 | 의문 종류 규칙 근사([5.6](#56-의문문-표정-근사-avatarstagetsx)) | 얼굴 70점 → VRM expression(`vrm.expressionManager`)을 `MotionKeyframe`에 확장 필드로 추가. 형태소 `attribute`(비수지 표시)와 연동 |
| 동작 확대 | REAL02 문장 317개 + 단어 영상 785개(`add_word_glosses.py`, 사전 일상어·시연 단어만) | `build_gloss_library.py --actor`로 다른 촬영자를 쓰거나 후보 선택 기준을 바꾼다. 같은 gloss의 여러 후보를 평균하지 말고(의미가 섞임) 대표 하나를 고른다 |
| 지문자 | 숫자·숫자+단위·역/명소 이름 249개를 **단어 통째로**(`add_fingerspell_glosses.py`). 지문자 데이터는 2D뿐이라 `lift_2d.py`로 깊이를 기하 계산 | 단어 영상을 자모 단위로 잘라(1글자 평균 1.15초) 사람 이름 등 임의 단어를 자모로 풀어 재생. 도로명 698개 추가 |
