"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import registry from "@data/expressions.json";
import { matchSentence, playableEntries } from "@/lib/matcher";
import { loadClipForEntry, MotionDataError } from "@/lib/motion";
import type { MotionPlayer, PlayerState } from "@/lib/MotionPlayer";
import type { ExpressionEntry, MatchSegment, MotionClip } from "@/lib/types";
import { QUESTION_EXPRESSION, type StageStatus } from "./AvatarStage";
import { buildLexicon, describePlan, planSentence, type DictEntry, type Lexicon, type PlanToken, type SignPlan } from "@/lib/ksl/planner";
import { parseCandidate, ruleIsConfident, verifyCandidate } from "@/lib/ksl/llm";

const AvatarStage = dynamic(() => import("./AvatarStage"), { ssr: false });
// 사용권한 확인 전에는 배포 빌드에서 AI-Hub 파생 모션을 보이지 않게 한다.
const SHOW_SAMPLES = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_SUEON_ALLOW_SAMPLE_PUBLIC === "true";
const ENTRIES = (registry.entries as ExpressionEntry[]).filter((e) => SHOW_SAMPLES || !e.expression_id.startsWith("AIHUB-SAMPLE-"));
// 운영 모드는 미검증 샘플을 제외하고, 개발 모드에서만 표제어 기반 시연을 허용한다.
const PUBLIC_ENTRIES = ENTRIES.filter((e) => e.kind === "ksl" || (SHOW_SAMPLES && e.expression_id.startsWith("AIHUB-SAMPLE-")));
const DEMO_ENTRIES = ENTRIES.filter((e) => e.kind === "test");
// ?debug=1&legacy=1: 이전 변환식(REAL01 근사) 모션과 새 REAL02 리타기팅 모션 비교
const legacyMotion = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("legacy") === "1";
const EXAMPLES = SHOW_SAMPLES ? ["택시 기본요금 얼마예요?", "다음 역에서 내려요", "지하철 어디서 타요?", "배를 탔어요", "골키퍼", "고민", "안녕하세요"] : ["안녕하세요", "감사합니다", "화장실은 어디예요?"];

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> } ) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

function segmentTone(s: MatchSegment) {
  if (s.status === "playable") return s.entry?.kind === "test" ? "test" : "ok";
  return s.status === "no_motion" ? "pending" : "bad";
}

/** 분석 결과의 수어 단어를 기존 재생 경로(ExpressionEntry)로 넘기기 위한 임시 항목 */
function planEntry(t: PlanToken): ExpressionEntry {
  return {
    expression_id: `AIHUB-SAMPLE-PLAN-${t.motion!.gloss}`, kind: "test", korean: t.motion!.gloss, match: [],
    motion_path: t.motion!.path, source: "AI-Hub REAL 문장/단어 3D 키포인트 파생(정확도 미검증)",
    verification_status: "not_sign_language", supported: true,
  };
}
const tokenLabel = (t: PlanToken) => t.sense && t.alternatives?.length
  ? `${t.lemma} (${t.sense.category.split(" > ").at(-1)})` : t.lemma;
const tokenNote = (t: PlanToken) => [
  t.note,
  t.sense && t.alternatives?.length ? `의미 선택: ${t.sense.reason} · 수어사전 ${t.sense.id}` : null,
  t.sense && t.status !== "playable" && t.sense.handshape ? `수형: ${t.sense.handshape}` : null,
].filter(Boolean).join(" · ");
const correctionText = (c: SignPlan["corrections"][number]) =>
  c.to ? `${c.from}→${c.to}${c.reason === "typo" ? "(오타 교정)" : ""}` : `'${c.from}' 뺌`;

export default function SignTranslator() {
  const [text, setText] = useState("");
  const [sentence, setSentence] = useState<string | null>(null);
  const [segments, setSegments] = useState<MatchSegment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [stage, setStage] = useState<StageStatus>({ kind: "loading", progress: 0 });
  const [playerState, setPlayerState] = useState<PlayerState | null>(null);
  const [loadedClips, setLoadedClips] = useState<MotionClip[]>([]);
  const [voiceState, setVoiceState] = useState<"idle" | "listening" | "processing">("idle");
  const [voiceMessage, setVoiceMessage] = useState("");
  const [debugMode, setDebugMode] = useState(false);
  const [viewMode, setViewMode] = useState<"upper" | "hands">("upper");
  const [reply, setReply] = useState("");
  // 규칙 기반 문장 분석(직접 구현): 국립국어원 사전 + 실제 촬영 문장에서 잘라 낸 수어 단어 동작
  const [lexicon, setLexicon] = useState<Lexicon | null>(null);
  const [plan, setPlan] = useState<SignPlan | null>(null);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  // LLM 판단 계층(선택): 서버에 키가 있을 때만 켜진다. 없으면 규칙 분석만 쓴다
  const [llm, setLlm] = useState<{ enabled: boolean; provider: string | null }>({ enabled: false, provider: null });
  const playerRef = useRef<MotionPlayer | null>(null);
  const latestClipsRef = useRef<MotionClip[]>([]);
  const unsubRef = useRef<(() => void) | null>(null);
  const recognitionRef = useRef<Recognition | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const seqRef = useRef(0);
  /** 같은 문장의 LLM 검증 결과(새로고침하면 비워짐) */
  const llmCacheRef = useRef(new Map<string, SignPlan>());

  useEffect(() => {
    // 실사용 화면과 관절 실험 도구를 명확히 분리한다.
    setDebugMode(process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).has("debug"));
  }, []);

  useEffect(() => {
    let alive = true;
    const get = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    // 운영 모드에서는 AI-Hub 파생 동작 경로가 차단되어 사전 분석만 동작한다.
    void Promise.all([SHOW_SAMPLES ? get("/motions/aihub_gloss/index.json") : null, get("/ksl/dictionary.json")]).then(([gloss, dict]) => {
      if (!alive) return;
      setLexicon(buildLexicon({
        glossItems: gloss?.items ?? {},
        words: ENTRIES.filter((e) => e.expression_id.startsWith("AIHUB-SAMPLE-WORD")),
        dictionary: (dict?.entries ?? []) as DictEntry[],
      }));
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    fetch("/api/analyze").then((r) => (r.ok ? r.json() : null)).then((info: { enabled?: boolean; provider?: string | null } | null) => {
      if (info?.enabled) setLlm({ enabled: true, provider: info.provider ?? null });
    }).catch(() => undefined);
  }, []);

  /**
   * 규칙 분석 → (LLM이 켜져 있고 규칙이 확실하지 않을 때만) LLM 후보를 받아 규칙·사전으로 검증. 실패·시간 초과면 규칙 결과.
   * 규칙이 확실하면 LLM을 부르지 않고(1~5초 → 1ms 미만), LLM 결과는 같은 문장에 다시 쓰도록 저장한다(캐시).
   */
  async function analyze(input: string, lex: Lexicon): Promise<SignPlan> {
    const rule = planSentence(input, lex);
    if (!llm.enabled) return rule;
    if (ruleIsConfident(rule)) return { ...rule, llmNotes: ["규칙 분석이 확실해 LLM을 부르지 않음(속도)"] };
    const cached = llmCacheRef.current.get(input);
    if (cached) return { ...cached, llmNotes: [...(cached.llmNotes ?? []), "같은 문장의 이전 LLM 결과 사용(캐시)"] };
    try {
      const res = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: input }), signal: AbortSignal.timeout(8000) });
      const payload = await res.json() as { candidate?: unknown; error?: string };
      if (!res.ok) return { ...rule, llmNotes: [`LLM 사용 못 함(${payload.error ?? res.status}) → 규칙 분석`] };
      const plan = verifyCandidate(input, parseCandidate(payload.candidate), lex, rule).plan;
      // 정상 응답만 저장한다(오류·시간 초과는 다음에 다시 시도). 너무 커지지 않게 오래된 것부터 지운다
      const cache = llmCacheRef.current;
      cache.set(input, plan);
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
      return plan;
    } catch {
      return { ...rule, llmNotes: ["LLM 응답 시간 초과·오류 → 규칙 분석"] };
    }
  }

  const handlePlayer = useCallback((p: MotionPlayer | null) => {
    unsubRef.current?.();
    playerRef.current = p;
    if (!p) return;
    let last = "";
    unsubRef.current = p.onChange((state) => {
      const sig = `${state.status}|${state.clipIndex}|${Math.floor(state.time * 10)}`;
      if (last !== sig) { last = sig; setPlayerState(state); }
    });
    // 모델 로딩 중 변환을 완료했어도, 모델 준비 후 재생 가능하게 한다.
    if (latestClipsRef.current.length) p.load(latestClipsRef.current);
  }, []);
  const handleStatus = useCallback((s: StageStatus) => setStage(s), []);
  useEffect(() => () => {
    unsubRef.current?.();
    recognitionRef.current?.stop();
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  async function convert(input: string, confirmed = false) {
    const trimmed = input.trim();
    if (!trimmed) return;
    const requestSeq = ++seqRef.current;
    setSentence(trimmed);
    setErrors([]);
    setAwaitingConfirm(false);
    let toLoad: ExpressionEntry[];
    // '#'로 시작하는 개발 명령은 기존 사전 매칭, 그 외 문장은 문장 분석기로 처리
    if (lexicon && !trimmed.startsWith("#")) {
      const p = await analyze(trimmed, lexicon);
      if (requestSeq !== seqRef.current) return;
      setPlan(p);
      setSegments([]);
      // 확실하지 않은 부분이 있어도 동작이 있는 단어는 바로 재생하고, 이해한 내용을 아래에 보여 고칠 수 있게 한다
      // (예전: 재생 전에 확인을 강제 → 한 단어만 애매해도 아무것도 안 나와 불편하다는 사용자 피드백)
      setAwaitingConfirm(p.needsConfirm && !confirmed);
      toLoad = p.order.filter((t) => t.status === "playable" && t.motion).map(planEntry);
    } else {
      setPlan(null);
      const next = matchSentence(trimmed, debugMode ? ENTRIES : PUBLIC_ENTRIES);
      setSegments(next);
      toLoad = playableEntries(next);
    }
    const clips: MotionClip[] = [];
    const errs: string[] = [];
    for (const entry of toLoad) {
      try { clips.push(await loadClipForEntry(entry, debugMode && legacyMotion())); }
      catch (e) { errs.push(e instanceof MotionDataError ? e.message : `${entry.korean} 동작 로드 실패`); }
    }
    if (requestSeq !== seqRef.current) return;
    setErrors(errs);
    setLoadedClips(clips);
    latestClipsRef.current = clips;
    if (playerRef.current) {
      if (clips.length) playerRef.current.load(clips);
      else playerRef.current.clear();
    }
  }

  function stopVoice() {
    recognitionRef.current?.stop();
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  async function startVoice() {
    if (voiceState !== "idle") { stopVoice(); return; }
    setVoiceMessage("");
    const Speech = (window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition;
    if (Speech) {
      try {
        const rec = new Speech();
        rec.lang = "ko-KR";
        rec.continuous = false;
        rec.interimResults = false;
        rec.onresult = (event) => {
          const words = Array.from(event.results).map((r) => r[0].transcript).join(" ").trim();
          if (words) { setText(words.slice(0, 200)); setVoiceMessage("음성 인식 완료 · 문장을 확인한 후 변환하세요."); }
        };
        rec.onerror = (event) => setVoiceMessage(`음성 인식 실패: ${event.error} · 텍스트 입력을 사용할 수 있습니다.`);
        rec.onend = () => { recognitionRef.current = null; setVoiceState("idle"); };
        recognitionRef.current = rec;
        setVoiceState("listening");
        rec.start();
        return;
      } catch { recognitionRef.current = null; setVoiceState("idle"); }
    }
    // Web Speech API가 없는 브라우저에서만 녹음 파일을 선택적 서버 ASR로 전송한다.
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceMessage("이 브라우저에서는 음성 입력을 사용할 수 없습니다. 텍스트를 입력해 주세요.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const pieces: BlobPart[] = [];
      rec.ondataavailable = (event) => { if (event.data.size) pieces.push(event.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setVoiceState("processing");
        try {
          const audio = new Blob(pieces, { type: rec.mimeType || "audio/webm" });
          const file = new File([audio], `speech.${rec.mimeType.includes("mp4") ? "mp4" : "webm"}`, { type: audio.type });
          const form = new FormData(); form.append("file", file);
          const res = await fetch("/api/transcribe", { method: "POST", body: form });
          const payload = await res.json() as { text?: string; error?: string };
          if (!res.ok || !payload.text) throw new Error(payload.error || "음성 인식 실패");
          setText(payload.text.slice(0,200));
          setVoiceMessage("서버 음성 인식 완료 · 내용을 확인해 주세요.");
        } catch { setVoiceMessage("음성 인식에 실패했습니다. 텍스트로 입력해 주세요."); }
        finally { recorderRef.current = null; setVoiceState("idle"); }
      };
      recorderRef.current = rec;
      rec.start(); setVoiceState("listening");
      setVoiceMessage("녹음 중입니다. 다시 누르면 음성 입력을 마칩니다.");
    } catch {
      setVoiceState("idle");
      setVoiceMessage("마이크 권한을 확인해 주세요. 모바일은 HTTPS 접속이 필요합니다.");
    }
  }

  function speakReply() {
    if (!("speechSynthesis" in window)) { setVoiceMessage("이 브라우저는 음성 출력을 지원하지 않습니다."); return; }
    window.speechSynthesis.cancel();
    if (!reply.trim()) return;
    const utterance = new SpeechSynthesisUtterance(reply.trim()); utterance.lang = "ko-KR";
    utterance.rate = 0.94; window.speechSynthesis.speak(utterance);
  }

  const hasPlayable = loadedClips.length > 0;
  const status = playerState?.status || "idle";
  const current = hasPlayable ? loadedClips[playerState?.clipIndex ?? 0] : null;
  // 문장 클립 재생 중이면 지금 시각의 수어 단어(gloss)를 보여 준다
  const currentGloss = current?.retarget?.gloss ?? current?.retarget?.gloss_segments
    ?.find(([, a, b]) => (playerState?.time ?? 0) >= a - 0.15 && (playerState?.time ?? 0) <= b + 0.15)?.[0] ?? null;
  const samplePlaying = current?.kind === "test" && (status === "playing" || status === "paused");
  const summary = useMemo(() => {
    if (plan) {
      const playable = plan.order.filter((t) => t.status === "playable").length;
      if (!playable) return "이해한 수어 단어 중 아직 동작 데이터가 있는 단어가 없습니다.";
      if (awaitingConfirm) return `동작이 있는 ${playable}개 단어를 먼저 보여 드려요. 확실하지 않은 부분이 있으니 아래 내용을 확인해 주세요.`;
      return `수어 단어 ${plan.order.length}개 중 ${playable}개를 실제 촬영 문장에서 잘라 낸 동작으로 이어서 재생합니다. ${plan.source === "llm" ? "LLM 후보를 규칙·사전으로 검사한 분석이며" : "규칙 기반 분석이며"} 한국수어 문법·정확성은 검증되지 않았습니다.`;
    }
    if (!segments.length) return "";
    const playable = segments.filter((s) => s.status === "playable").length;
    const missing = segments.filter((s) => s.status === "no_motion").length;
    const unsupported = segments.filter((s) => s.status === "unsupported").length;
    if (!playable) return missing ? "아직 재생할 수 있는 수어 동작이 없습니다." : "해당 표현은 아직 지원하지 않습니다.";
    if (segments.some((s) => s.entry?.expression_id.startsWith("AIHUB-SAMPLE-"))) return "AI-Hub 촬영본(REAL02)의 3D 관절과 같은 촬영본의 표제어·수어 구간으로 만든 실험용 재생입니다. 한국수어 의미·손형 정확성은 아직 검증되지 않았습니다.";
    if (segments.some((s) => s.entry?.kind === "test")) return "개발용 관절 제어 테스트이며 한국수어가 아닙니다.";
    return unsupported || missing ? "지원되는 표현만 재생합니다. 일부 표현은 아직 제공되지 않습니다." : "동작을 재생합니다.";
  }, [segments, plan, awaitingConfirm]);

  const friendlyName = (s: MatchSegment) => {
    if (s.entry?.kind === "test") {
      const code = s.entry.expression_id.match(/WORD(\d+)/)?.[1];
      return code ? `${s.entry.korean} (실험용)` : s.entry.expression_id === "TEST-0001" ? "손가락 움직임" : "팔·손목 움직임";
    }
    return s.entry?.korean || s.text;
  };
  const statusText = (s: MatchSegment) => s.status === "playable"
    ? s.entry?.kind === "test" ? (s.entry.expression_id.startsWith("AIHUB-SAMPLE-") ? "정확도 미검증" : "관절 테스트") : "재생 가능"
    : s.status === "no_motion" ? "준비 중" : "지원 전";
  function useDemo(entry: ExpressionEntry) {
    setText(entry.match[0]);
    // 샘플 재생은 사용자 입력 매칭의 별도 가공 없이 검증된 경로를 사용한다.
    void convert(entry.match[0]);
    if (window.innerWidth < 861) document.getElementById("avatar-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return <main className="app">
    <header className="masthead">
      <div className="brand-mark" aria-hidden="true">S:</div>
      <div><h1>SUEO:N <small>수어온</small></h1><p>손으로 전하는 더 가까운 소통</p></div>
    </header>

    <div className="layout">
      <section className="panel input-panel" aria-labelledby="input-title">
        <h2 id="input-title">한국어로 말하거나 입력하세요</h2>
        <form onSubmit={(e) => { e.preventDefault(); void convert(text); }}>
          <label htmlFor="sentence" className="sr-only">한국어 문장</label>
          <textarea id="sentence" rows={2} maxLength={200} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="전하고 싶은 말을 입력하세요" onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void convert(text); }
            }} />
          <div className="input-tools">
            <button type="button" onClick={() => void startVoice()} className={`voice-button ${voiceState !== "idle" ? "voice-active" : ""}`}
              aria-pressed={voiceState === "listening"} disabled={voiceState === "processing"}>
              {voiceState === "listening" ? "■ 녹음 종료" : voiceState === "processing" ? "변환 중..." : "🎙 음성 입력"}
            </button>
            <button className="primary convert-button" type="submit" disabled={!text.trim()}>수어로 보기</button>
          </div>
          {voiceMessage && <p className="voice-message" role="status">{voiceMessage}</p>}
        </form>
        <details className="examples-toggle">
          <summary>예시 문장</summary>
          <div className="examples" aria-label="예시 문장">
            {EXAMPLES.map((example) => <button type="button" key={example} className="chip" onClick={() => { setText(example); void convert(example); }}>{example}</button>)}
          </div>
        </details>
      </section>

      <section className="stage-col" aria-labelledby="avatar-title">
        <div className="stage-heading">
          <h2 id="avatar-title">수어 아바타</h2>
          <button type="button" className="zoom-button" aria-pressed={viewMode === "hands"} onClick={() => setViewMode(viewMode === "hands" ? "upper" : "hands")}>
            {viewMode === "hands" ? "전체 보기" : "손동작 확대"}
          </button>
        </div>
        <AvatarStage onPlayer={handlePlayer} onStatus={handleStatus} viewMode={viewMode}
          expression={plan?.question ? QUESTION_EXPRESSION[plan.question] : null}>
          {sentence && <div className="bubble" aria-label="입력한 문장">{plan ? describePlan(plan) || sentence : segments.some((s) => s.entry?.expression_id.startsWith("AIHUB-SAMPLE-")) ? "AI-Hub 3D 키포인트 동작 · 정확도 미검증" : segments.some((s) => s.entry?.kind === "test") ? "관절 테스트 · 한국수어 아님" : sentence}</div>}
          {stage.kind === "loading" && <p className="stage-loading">아바타 불러오는 중 {Math.round(stage.progress * 100)}%</p>}
          {samplePlaying && <p className="test-flag">{current?.motion_id.startsWith("AIHUB-") ? "AI-Hub 3D 리타기팅 · 한국수어 정확도 미검증" : "관절 제어용 테스트 · 한국수어 아님"}</p>}
        </AvatarStage>
        <div className="controls">
          <div className="now" role="status">
            {stage.kind === "error" ? <span className="now-error">{stage.message}</span> : current && status !== "idle" ?
              <><span>{currentGloss ? `수어: ${currentGloss}` : samplePlaying ? "정확도 미검증 모션" : "재생 중"}</span><progress max={current.duration} value={Math.min(playerState?.time ?? 0, current.duration)} aria-label="재생 진행률" /></> :
              <span className="muted">{hasPlayable ? "재생 완료" : stage.kind === "ready" ? "문장을 입력해 주세요" : "아바타 준비 중"}</span>}
          </div>
          <div className="buttons">
            <button type="button" disabled={!hasPlayable || stage.kind !== "ready" || !["playing","paused"].includes(status)} onClick={() => status === "paused" ? playerRef.current?.resume() : playerRef.current?.pause()}>{status === "paused" ? "▶ 계속" : "Ⅱ 일시정지"}</button>
            <button type="button" className="primary" disabled={!hasPlayable || stage.kind !== "ready"} onClick={() => playerRef.current?.replay()}>↺ 다시 재생</button>
            <button type="button" disabled={!hasPlayable || stage.kind !== "ready" || status === "idle"} onClick={() => playerRef.current?.stop()}>■ 정지</button>
          </div>
        </div>
      </section>

      <div className="more-panel">
        {plan && <section className="result" aria-live="polite">
          <h2>이렇게 이해했어요</h2>
          <p className="summary">{summary}</p>
          {(plan.source === "llm" || plan.llmNotes?.length) && <p className="plan-source">
            {plan.source === "llm" ? `분석: LLM 후보(${llm.provider}) + 규칙·사전 검증` : "분석: 규칙 기반"}
          </p>}
          <ul className="segments">{plan.order.map((t, i) => <li className={`seg seg-${t.status === "playable" ? "test" : t.status === "unknown" ? "bad" : "pending"}`} key={`${t.lemma}-${i}`}>
            <span className="seg-word">{tokenLabel(t)}</span><span className="badge">{t.status === "playable" ? "동작 있음" : t.status === "unknown" ? "모르는 말" : "동작 없음"}</span>
            {tokenNote(t) ? <span className="seg-note">{tokenNote(t)}</span> : null}
          </li>)}</ul>
          {(plan.question || plan.negation || plan.corrections.length > 0) && <ul className="plan-notes">
            {plan.question && <li>{plan.question === "wh" ? "의문사 질문 → 의문사를 문장 끝에 두고 눈썹을 모으는 표정(근사, 미검증)" : "예/아니요 질문 → 눈썹을 올리는 표정(근사, 미검증)"}</li>}
            {plan.negation && <li>부정 표현 → 동사 뒤에 부정 수어</li>}
            {plan.corrections.length > 0 && <li>정리: {plan.corrections.map(correctionText).join(", ")}</li>}
          </ul>}
          {plan.llmNotes?.length ? <details className="llm-notes"><summary>LLM 검증 기록</summary>
            <ul>{plan.llmNotes.map((n, i) => <li key={i}>{n}</li>)}</ul></details> : null}
          {awaitingConfirm && <div className="confirm-box" role="alert">
            <p>{plan.reasons.join(" · ")}</p>
            <div className="buttons">
              <button type="button" className="primary" onClick={() => setAwaitingConfirm(false)}>맞아요</button>
              <button type="button" onClick={() => { setAwaitingConfirm(false); setPlan(null); document.getElementById("sentence")?.focus(); }}>다시 입력</button>
            </div>
          </div>}
          {errors.length > 0 && <ul className="errors" role="alert">{errors.map((error, i) => <li key={i}>동작을 불러오지 못했습니다. {debugMode ? error : "다시 시도해 주세요."}</li>)}</ul>}
        </section>}
        {segments.length > 0 && <section className="result" aria-live="polite">
          <h2>변환 결과</h2>
          <p className="summary">{summary}</p>
          <ul className="segments">{segments.map((s, i) => <li className={`seg seg-${segmentTone(s)}`} key={`${s.text}-${i}`}>
            <span className="seg-word">{friendlyName(s)}</span><span className="badge">{statusText(s)}</span>
          </li>)}</ul>
          {errors.length > 0 && <ul className="errors" role="alert">{errors.map((error, i) => <li key={i}>동작을 불러오지 못했습니다. {debugMode ? error : "다시 시도해 주세요."}</li>)}</ul>}
        </section>}
        <section className="reply-panel">
          <h2>상대방에게 답하기</h2>
          <label htmlFor="reply" className="sr-only">답변</label>
          <input id="reply" value={reply} onChange={(e) => setReply(e.target.value)} maxLength={200} placeholder="답변을 입력하세요" />
          <button type="button" onClick={speakReply} disabled={!reply.trim()}>🔊 입력한 말 읽어주기</button>
        </section>
        {debugMode && <details className="dev-tools">
          <summary>관절 동작 확인 (개발용)</summary>
          <p>표제어는 AI-Hub REAL16_F 형태소 원본에서 확인했지만, 연결한 근사 모션의 촬영자·수어 정확성은 확인되지 않았습니다.</p>
          <div className="examples">{DEMO_ENTRIES.map((entry) => <button type="button" className="chip chip-test" key={entry.expression_id} onClick={() => useDemo(entry)}>
            {entry.expression_id === "TEST-0001" ? "손가락 테스트" : entry.expression_id === "TEST-0002" ? "팔 테스트" : `${entry.korean} (샘플 ${Number(entry.expression_id.match(/WORD(\d+)/)?.[1] || "1500") - 1500})`}
          </button>)}</div>
        </details>}
      </div>
    </div>
  </main>;
}
