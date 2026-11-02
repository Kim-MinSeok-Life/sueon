/**
 * 수어온 데이터 타입.
 *
 * 핵심 규칙: 한국수어(ksl) 데이터와 개발용 테스트 동작(test)은 kind로 구분하며,
 * 화면 표시·검증 스크립트 모두 이 값을 기준으로 다르게 처리한다.
 */

/** 표현의 종류 */
export type ExpressionKind =
  /** 실제 한국수어 표현. 출처가 있는 동작 데이터만 연결할 수 있다. */
  | "ksl"
  /** 아바타 관절 제어를 확인하기 위한 개발용 동작. 한국수어가 아니다. */
  | "test";

/** 검증 상태 */
export type VerificationStatus =
  /** 수어 사용자(농인·수어통역사)가 동작을 확인함 */
  | "verified"
  /** 출처 있는 데이터에서 변환했으나 사람이 확인하지 않음 */
  | "unverified"
  /** 표현만 등록되어 있고 동작 데이터가 아직 없음 */
  | "data_pending"
  /** 테스트 동작. 수어가 아니므로 검증 대상이 아님 */
  | "not_sign_language";

export interface ExpressionEntry {
  expression_id: string;
  kind: ExpressionKind;
  /** 대표 한국어 표현 */
  korean: string;
  /** 입력 문장에서 찾을 문자열(대표 표현 포함) */
  match: string[];
  /** 동작 데이터 경로(public 기준). 데이터가 없으면 null — 임의 경로를 넣지 않는다. */
  motion_path: string | null;
  /** 데이터 출처. 확보 전이면 확보 예정 출처를 source_candidate에 적는다. */
  source: string | null;
  source_candidate?: string | null;
  verification_status: VerificationStatus;
  /** motion_path가 있고 재생 가능한 경우에만 true */
  supported: boolean;
  note?: string;
  /** 형태소 파일에서 확인한 WORD ID (모션 촬영자 일치를 의미하지 않음) */
  morpheme_ref?: string;
  /** 근사 키프레임 원본 촬영자: 확인 전에는 unknown */
  motion_source_actor?: string;
  source_video?: string;
  gloss_interval_sec?: [number, number];
  motion_quality?: "experimental_unvalidated";
  /** 이전 변환식(attempt1~4) 모션 경로. 개발 비교(?legacy=1)용 */
  legacy_motion_path?: string;
  /** 모션을 만든 실제 촬영본 (예: NIA_SL_WORD1502_REAL02_F) */
  motion_take?: string;
  /** 표제어(형태소)와 모션이 같은 촬영자에서 왔는지 */
  label_motion_same_actor?: boolean;
  /** 실제 촬영 문장의 수어 gloss 순서 (한국어 번역문 아님) */
  gloss_sequence?: string[];
}

/** 쿼터니언 [x, y, z, w] — VRM 정규화 본 공간 기준 */
export type Quat = [number, number, number, number];

export interface MotionKeyframe {
  /** 초 단위 시간 */
  t: number;
  /** VRM humanoid bone 이름 → 회전 */
  bones: Record<string, Quat>;
}

export interface MotionClip {
  format: "sueon-keyframes/v1";
  motion_id: string;
  kind: ExpressionKind;
  label: string;
  /** 본 회전이 정의된 공간 */
  space: "vrm-normalized-humanoid";
  duration: number;
  source: string;
  keyframes: MotionKeyframe[];
  /** scripts/retarget_vrm.py로 만든 클립의 처리 정보 (선택) */
  retarget?: {
    method: string;
    take: string;
    source_frames: [number, number];
    source_total_frames: number;
    trim: string;
    fps: number;
    /** 개발용 원본 관절 비교 데이터(public 경로) */
    skeleton?: string;
    /** 문장 클립: [gloss, 시작초, 끝초] (클립 시작 기준, 같은 촬영본 형태소) */
    gloss_segments?: [string, number, number][];
    /** 문장에서 잘라 낸 단일 gloss 클립의 gloss와 원본 문장 */
    gloss?: string;
    source_sentence?: string;
  };
}

export type SegmentStatus =
  /** 동작 데이터가 연결되어 재생 가능 */
  | "playable"
  /** 사전에 등록되었지만 동작 데이터 없음 */
  | "no_motion"
  /** 사전에 없는 표현 */
  | "unsupported";

export interface MatchSegment {
  text: string;
  status: SegmentStatus;
  entry: ExpressionEntry | null;
}
