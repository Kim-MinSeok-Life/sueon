# 크레딧 및 라이선스

## 한눈에 보기

| 자료 | 출처 | 라이선스·조건 | Git | 공유 ZIP |
|---|---|---|:---:|:---:|
| 3D 아바타 `public/models/avatar.vrm` | pixiv Inc. VRM 샘플 | VRM Public License 1.0 (재배포·수정 허용) | ✅ | ✅ |
| 수어 단어 동작 `public/motions/aihub_gloss`, `aihub_real02` | AI-Hub 수어 영상(데이터셋 103) 파생 | 경진대회 목적 이용약관 동의 · AI 학습용 → **팀 내부(비공개)만** | ✅(비공개) | ✅(팀 내부만) |
| 옛 근사 동작 `public/motions/sample`, `stabilized` | AI-Hub 경량 샘플 파생(attempt1~3) | 위와 같음 | ✅(비공개) | ✅(팀 내부만) |
| 발췌 키포인트 `data/keypoints/` | AI-Hub 원본 좌표 발췌 | 원본 데이터로 취급 | ❌ | ✅(팀 내부만) |
| 형태소 원본 `data/morphemes/` (작은 JSON 몇 개) | AI-Hub 형태소 라벨 | 권한 확인 때 함께 검토 | ✅ | ✅ |
| 수어사전 `public/ksl/dictionary.json` | 국립국어원 한국수어사전(공공데이터포털 15135637) | 공공데이터포털 이용 조건 확인 필요 | ✅ | ✅ |
| 테스트 동작 `public/motions/test/` | 직접 제작(`scripts/build-test-motions.mjs`) | 팀 자체 제작 · **수어 아님** | ✅ | ✅ |
| AI-Hub 원본(약 95GB) | AI-Hub | 이용 신청자만 | ❌ | ❌ |

> **한국수어 전문가·국립국어원 기준으로 검수한 동작: 0건.** 모든 동작은 실험용이며 실제 수어 번역으로 취급하지 않습니다.
> AI-Hub 파생 동작은 2026-11-02 팀 결정으로 **비공개** GitHub 저장소에 포함합니다. 인터넷 공개 서비스 배포는 운영 빌드에서 경로가 계속 차단됩니다(`src/proxy.ts`). 원본과 발췌 키포인트는 Git에서 제외합니다(`.gitignore`).

---

## 3D 아바타

| 항목 | 내용 |
|---|---|
| 원본 이름 | VRM1_Constraint_Twist_Sample |
| 저작권 | (c) 2022 pixiv Inc. |
| 라이선스 | VRM Public License 1.0 — https://vrm.dev/licenses/1.0/ |
| 출처 | https://github.com/vrm-c/vrm-specification/tree/master/samples/VRM1_Constraint_Twist_Sample |
| 가져온 시점 | 2026-10-29, 커밋 `94e82dd346fa6cf0337c4421728640e5252dd38e` |
| 변경 | 파일명만 `avatar.vrm`으로 변경. 내용 동일(SHA-256 `12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2`) |

VRM 파일 안의 이용 조건(`VRMC_vrm.meta`, 파일에서 직접 읽은 값):

| 필드 | 값 | 의미 |
|---|---|---|
| avatarPermission | everyone | 누구나 아바타로 사용 가능 |
| commercialUsage | corporation | 기업의 상업 이용까지 허용 |
| creditNotation | unnecessary | 크레딧 표기 의무 없음(그래도 표기함) |
| allowRedistribution | true | 재배포 허용 |
| modification | allowModificationRedistribution | 수정·수정본 재배포 허용 |
| allowAntisocialOrHateUsage | false | 반사회적·혐오 목적 사용 금지 |

> 라이선스 전문은 작업 환경에서 vrm.dev 접속이 막혀 저장소에 넣지 못했습니다. 배포 전 위 주소에서 확인하세요.

---

## AI-Hub 파생 동작 — 만든 과정

| 시기 | 원본 | 처리 | 결과 |
|---|---|---|---|
| attempt1~3 | 경량 샘플 `New_sample.zip`(이용 신청 후 전달받음) | `import-aihub-sample.py`로 근사 회전 변환 → `stabilize-sample-motions.py`로 급회전 완화 | `motions/sample`, `motions/stabilized` (8단어) |
| attempt5 | `[라벨]02_real_word_keypoint.zip`(촬영자 REAL02) | `aihub_keypoints.py`(발췌·단위 정규화) → `retarget_vrm.py`(수학적 리타기팅) | `motions/aihub_real02` (단어 9개) |
| attempt5~6 | `[라벨]02_real_sen_keypoint.zip` + `[라벨]01_real_sen_morpheme.zip`(REAL02 문장) | `build_gloss_library.py`로 형태소 구간을 잘라 리타기팅 | `motions/aihub_gloss` (단어 317개) |

- 모두 **AI 모델 학습 결과가 아니라** 실제 촬영 좌표를 수학적으로 옮긴 것입니다.
- attempt3까지의 근사 동작은 촬영자(REAL01)와 라벨(REAL16)이 달랐습니다. attempt5부터는 같은 촬영자(REAL02)의 형태소를 씁니다.
- 원본 출처: [AI-Hub 수어 영상 (데이터셋 103)](https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=103)
- 아바타 저작권과 AI-Hub 데이터 이용권은 별개입니다.

---

## 오픈소스 의존성 (npm 설치, 저장소에는 미포함)

| 패키지 | 버전 | 라이선스 |
|---|---|---|
| next | 16.4.1 | MIT |
| react / react-dom | 19.2.9 | MIT |
| three | 0.186.1 | MIT |
| @pixiv/three-vrm | 3.5.5 | MIT |
| @anthropic-ai/sdk (LLM 선택 기능) | 1.3.0 | Apache-2.0 |
| pretendard (글꼴) | 1.3.9 | SIL Open Font License 1.1 |
