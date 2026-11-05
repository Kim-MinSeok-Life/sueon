"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AvatarStage, { type StageStatus } from "@/components/AvatarStage";
import type { MotionPlayer } from "@/lib/MotionPlayer";
import { validateClip } from "@/lib/motion";
import type { MotionClip } from "@/lib/types";

// 원본 영상 ↔ 아바타 비교 검수 화면(개발 전용).
// 아바타 자세는 영상 재생 시각에 맞춰 매 화면마다 정한다(같은 촬영자면 같은 시각, 다른 촬영자면 단어 구간 길이에 맞춰 늘이거나 줄임).
// 판정은 이 브라우저(localStorage)에만 저장되므로 "검수 결과 내려받기"로 파일을 남긴다.

interface CompareItem {
  key: string;
  label: string;
  kind: "gloss" | "word";
  motion_path: string;
  motion_take: string;
  motion_segment: [number, number] | null;
  occurrences?: number;
  /** 원본 영상이 없으면 null(지문자·일부 단어 영상): 아바타만 반복 재생하고 국립국어원 표준 영상과 비교 */
  video_take: string | null;
  video_segment: [number, number] | null;
  video_duration: number | null;
  video_glosses: string[];
  same_actor: boolean;
}
interface Manifest { actor: string; items: CompareItem[]; missing_video: string[]; summary: { targets: number; with_video: number; same_actor: number; video_actors: string[] } }
interface DictEntry { id: number; w: [string, string?][]; c: string; h: string }
type Verdict = "same" | "different" | "unsure";
interface Review { avatar?: Verdict; nikl?: Verdict; memo?: string; at?: string }

const STORE = "sueon-video-review-v1";
const PAD = 0.15; // 동작 사전 클립과 같은 앞뒤 여유(초)
const VERDICT_TEXT: Record<Verdict, string> = { same: "같음", different: "다름", unsure: "애매" };
// 시연 대화(지하철역 길 안내 2가지)의 역무원 대사에 나오는 수어 단어. 최종 검수를 이 단어부터 한다
const DEMO_WORDS = new Set(["안녕하세요", "돕다", "도와주다", "무엇", "서울역", "1호", "타다", "가다", "교통카드", "매표소", "사다", "오른쪽", "있다",
  "엘리베이터", "왼쪽", "천천히", "조심", "경복궁", "3호", "5분", "지하철", "후", "오다", "곳", "내리다"]);
const niklUrl = (id: number) => `https://sldict.korean.go.kr/front/sign/signContentsView.do?origin_no=${id}&top_category=CTE`;

// 원본 영상이 있으면 '아바타 = 원본' 판정, 없으면 '아바타 = 국립국어원' 판정이 있어야 검수 완료
const isDone = (it: CompareItem, r?: Review) => !!(it.video_take ? r?.avatar : r?.nikl);

function loadReviews(): Record<string, Review> {
  try { return JSON.parse(localStorage.getItem(STORE) ?? "{}"); } catch { return {}; }
}

export default function ComparePage() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState("");
  const [dict, setDict] = useState<DictEntry[]>([]);
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "demo" | "todo" | "done" | "problem">("all");
  const [speed, setSpeed] = useState(1);
  const [wholeSentence, setWholeSentence] = useState(false);
  const [loop, setLoop] = useState(true);
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [stage, setStage] = useState<StageStatus>({ kind: "loading", progress: 0 });
  const [clip, setClip] = useState<MotionClip | null>(null);
  const playerRef = useRef<MotionPlayer | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const niklRef = useRef<HTMLVideoElement>(null);
  const [niklId, setNiklId] = useState<number | null>(null);
  const [nikl, setNikl] = useState<{ video: string | null; page: string; error?: string } | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    setReviews(loadReviews());
    fetch("/api/aihub-video").then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setManifest(body as Manifest);
    }).catch((e: Error) => setError(e.message));
    fetch("/ksl/dictionary.json").then((r) => (r.ok ? r.json() : null)).then((d) => setDict(d?.entries ?? [])).catch(() => {});
  }, []);

  const items = useMemo(() => {
    const all = manifest?.items ?? [];
    return all.map((it, i) => ({ it, i })).filter(({ it }) => {
      const r = reviews[it.key];
      if (query && !it.label.includes(query.trim())) return false;
      if (filter === "demo") return DEMO_WORDS.has(it.label);
      if (filter === "todo") return !isDone(it, r);
      if (filter === "done") return isDone(it, r);
      if (filter === "problem") return r?.avatar === "different" || r?.nikl === "different" || r?.avatar === "unsure";
      return true;
    });
  }, [manifest, reviews, query, filter]);
  const item = manifest?.items[selected] ?? null;
  const review = item ? reviews[item.key] ?? {} : {};
  const senses = useMemo(() => item ? dict.filter((e) => e.w.some(([w]) => w === item.label)) : [], [dict, item]);

  // 국립국어원 표준 영상: 기본은 첫 번째 뜻. 뜻 목록에서 다른 뜻을 고를 수 있다
  useEffect(() => { setNiklId(senses[0]?.id ?? null); }, [senses]);
  useEffect(() => {
    setNikl(null);
    if (niklId == null) return;
    let alive = true;
    fetch(`/api/nikl-video?id=${niklId}`).then((r) => r.json()).then((b) => { if (alive) setNikl(b); })
      .catch(() => alive && setNikl({ video: null, page: "", error: "국립국어원 영상을 찾지 못했습니다." }));
    return () => { alive = false; };
  }, [niklId]);

  // 영상에서 보여 줄 구간: 해당 수어 단어(앞뒤 여유 포함) 또는 문장 전체
  const range = useMemo((): [number, number] => {
    if (!item || !item.video_segment) return [0, 0];
    if (wholeSentence || item.kind === "word") return [0, item.video_duration ?? 1e9];
    return [Math.max(0, item.video_segment[0] - PAD), item.video_segment[1] + PAD];
  }, [item, wholeSentence]);

  useEffect(() => {
    if (!item) return;
    let alive = true;
    setClip(null);
    fetch(item.motion_path).then((r) => r.json()).then((raw) => { if (alive) setClip(validateClip(raw)); })
      .catch((e: Error) => alive && setError(`동작 파일을 불러오지 못했습니다: ${e.message}`));
    return () => { alive = false; };
  }, [item]);

  const playBoth = useCallback(() => {
    const n = niklRef.current;
    if (n) { n.playbackRate = speed; n.currentTime = 0; void n.play().catch(() => {}); }
    if (item && !item.video_take) { playerRef.current?.replay(); return; }
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = speed;
    v.currentTime = range[0];
    void v.play().catch(() => {});
  }, [range, speed, item]);

  // 영상 시각 → 아바타 동작 시각. 수어 단어 구간(영상)과 핵심 구간(동작)을 직선으로 대응시킨다
  const toClipTime = useCallback((vt: number) => {
    if (!item || !clip) return 0;
    const seg = clip.retarget?.gloss_segments?.[0];
    if (item.kind === "gloss" && seg && item.video_segment) {
      const [vs, ve] = item.video_segment;
      const [cs, ce] = [seg[1], seg[2]];
      return Math.max(0, Math.min(clip.duration, cs + (vt - vs) * (ce - cs) / Math.max(0.01, ve - vs)));
    }
    // 단어 단독 촬영: 같은 촬영자면 잘라 낸 시작 프레임만큼 당기고, 다른 촬영자면 전체 길이 비율
    const fps = clip.retarget?.fps ?? 30;
    const start = (clip.retarget?.source_frames?.[0] ?? 0) / fps;
    if (item.same_actor) return Math.max(0, Math.min(clip.duration, vt - start));
    return clip.duration * vt / Math.max(0.01, item.video_duration ?? clip.duration);
  }, [item, clip]);

  // 동작을 불러와 두고 영상 시각에 맞춰 자세를 계속 맞춘다
  useEffect(() => {
    const player = playerRef.current;
    if (!clip || !player || stage.kind !== "ready") return;
    player.load([clip]);
    if (!item?.video_take) { // 원본 영상 없음: 아바타만 재생(반복 켜져 있으면 끝날 때마다 다시)
      player.replay();
      const id = loop ? window.setInterval(() => player.replay(), (clip.duration + 0.8) * 1000) : 0;
      return () => window.clearInterval(id);
    }
    let raf = 0;
    let last = -1;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const t = toClipTime(v.currentTime);
        if (Math.abs(t - last) > 1e-4) { player.seek(t); last = t; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    playBoth();
    return () => cancelAnimationFrame(raf);
  }, [clip, stage.kind, toClipTime, playBoth, item, loop]);

  // 이전·다음 단어 영상을 미리 받아 두어 넘길 때 검은 화면을 줄인다
  useEffect(() => {
    const items = manifest?.items ?? [];
    for (const i of [selected + 1, selected - 1]) {
      const it = items[i];
      if (it?.video_take) void fetch(`/api/aihub-video/${it.video_take}`).then((r) => r.arrayBuffer()).catch(() => {});
    }
  }, [manifest, selected]);

  // 구간 끝에서 멈추거나 처음부터 반복
  const onTime = () => {
    const v = videoRef.current;
    if (!v || v.currentTime < range[1]) return;
    if (loop) playBoth();
    else v.pause();
  };

  const save = (patch: Partial<Review>) => {
    if (!item) return;
    const next = { ...reviews, [item.key]: { ...review, ...patch, at: new Date().toISOString() } };
    setReviews(next);
    try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* 저장 불가 환경: 화면에서만 유지 */ }
  };

  const exportReviews = () => {
    if (!manifest) return;
    const rows = manifest.items.filter((it) => reviews[it.key]).map((it) => ({
      word: it.label, kind: it.kind, avatar_motion: it.motion_path, avatar_take: it.motion_take,
      video_take: it.video_take, same_actor: it.same_actor,
      avatar_vs_video: reviews[it.key].avatar ?? null, avatar_vs_nikl: reviews[it.key].nikl ?? null,
      memo: reviews[it.key].memo ?? "", reviewed_at: reviews[it.key].at,
    }));
    const blob = new Blob([JSON.stringify({ format: "sueon-video-review/v1", exported_at: new Date().toISOString(), rows }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `video_review_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handlePlayer = useCallback((p: MotionPlayer | null) => { playerRef.current = p; }, []);
  const handleStatus = useCallback((s: StageStatus) => setStage(s), []);

  if (process.env.NODE_ENV === "production") return <main className="app"><p>개발 모드 전용 화면입니다.</p></main>;
  const reviewed = manifest ? manifest.items.filter((it) => isDone(it, reviews[it.key])).length : 0;

  return (
    <main className="app compare">
      <header className="compare-head">
        <h1>원본 영상 ↔ 아바타 ↔ 국립국어원 비교</h1>
        <p className="muted">
          {manifest ? <>영상 있는 단어 {manifest.summary.with_video}개 / 전체 {manifest.summary.targets}개 · 검수 {reviewed}개 · 영상 촬영자 {manifest.summary.video_actors.join(", ")}</> : error || "비교표 불러오는 중…"}
        </p>
      </header>
      {manifest && manifest.summary.same_actor === 0 && <p className="compare-warn">
        지금 영상은 아바타 동작을 만든 촬영자({manifest.actor})가 아니라 다른 촬영자의 영상입니다. 같은 문장·같은 수어 단어인지 확인하는 용도이며, 손 위치·타이밍이 1:1로 맞지는 않습니다.
      </p>}
      {error && manifest && <p className="errors">{error}</p>}

      <div className="compare-grid">
        <aside className="panel compare-list">
          <input type="search" placeholder="단어 찾기" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="단어 찾기" />
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="검수 상태로 거르기">
            <option value="all">전체</option><option value="demo">시연 단어</option><option value="todo">검수 전</option><option value="done">검수 완료</option><option value="problem">다름·애매</option>
          </select>
          <ul>{items.map(({ it, i }) => {
            const r = reviews[it.key];
            return <li key={it.key}><button type="button" aria-current={i === selected} onClick={() => setSelected(i)}>
              <span>{it.label}</span>
              <span className={`mini mini-${r?.avatar ?? r?.nikl ?? "none"}`}>{r?.avatar ? VERDICT_TEXT[r.avatar] : r?.nikl ? VERDICT_TEXT[r.nikl] : !it.video_take ? "영상 없음" : it.kind === "word" ? "단어" : ""}</span>
            </button></li>;
          })}</ul>
        </aside>

        {item && <section className="compare-main">
          <div className="compare-pair">
            <figure>
              <figcaption>{item.video_take ? <>원본 영상 · {item.video_take}{item.same_actor ? "" : " (다른 촬영자)"}</> : "원본 영상 없음"}</figcaption>
              {item.video_take
                ? <video ref={videoRef} key={item.video_take} src={`/api/aihub-video/${item.video_take}`} muted playsInline preload="auto" onTimeUpdate={onTime} />
                : <p className="muted">{item.motion_take.includes("CROWD") ? "지문자(일반인 촬영) 원본 영상은 받지 않았습니다." : "이 단어의 원본 영상 파일이 없습니다."} 아래 국립국어원 표준 영상과 아바타를 비교해 주세요.</p>}
            </figure>
            <figure>
              <figcaption>아바타 · {item.motion_take}에서 분할</figcaption>
              <AvatarStage onPlayer={handlePlayer} onStatus={handleStatus} viewMode="upper">
                {stage.kind === "loading" && <p className="stage-loading">아바타 불러오는 중 {Math.round(stage.progress * 100)}%</p>}
              </AvatarStage>
            </figure>
            <figure>
              <figcaption>국립국어원 한국수어사전 표준 영상{niklId != null ? ` · ${niklId}` : ""}</figcaption>
              {nikl?.video
                ? <video ref={niklRef} key={nikl.video} src={nikl.video} muted playsInline autoPlay loop={loop} controls preload="auto" />
                : <p className="muted">{niklId == null ? "국립국어원 사전에 같은 표제어가 없습니다. 아래 '국립국어원 수어사전에서 찾기'로 검색해 주세요."
                  : nikl ? (nikl.error ?? "영상이 없습니다.") : "표준 영상 찾는 중…"}</p>}
            </figure>
          </div>
          <div className="controls">
            <div className="buttons">
              <button type="button" className="primary" onClick={playBoth} disabled={!clip || stage.kind !== "ready"}>↺ 같이 재생</button>
              <button type="button" onClick={() => { const v = videoRef.current; if (v) { if (v.paused) void v.play().catch(() => {}); else v.pause(); } }}>Ⅱ / ▶</button>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="재생 속도">
                <option value={1}>1배</option><option value={0.5}>0.5배</option><option value={0.25}>0.25배</option>
              </select>
              <label className="check"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> 반복</label>
              {item.kind === "gloss" && <label className="check"><input type="checkbox" checked={wholeSentence} onChange={(e) => setWholeSentence(e.target.checked)} /> 영상 문장 전체</label>}
            </div>
            <div className="buttons">
              <button type="button" disabled={selected <= 0} onClick={() => setSelected(selected - 1)}>← 이전</button>
              <button type="button" disabled={selected >= (manifest?.items.length ?? 1) - 1} onClick={() => setSelected(selected + 1)}>다음 →</button>
            </div>
          </div>

          <div className="panel compare-info">
            <h2>{item.label} <span className="muted">({item.kind === "gloss" ? `문장 속 수어 단어 · 촬영 문장 ${item.occurrences ?? "?"}회 등장` : "단어 단독 촬영"})</span></h2>
            <p className="muted">{item.video_take ? <>영상 문장의 수어 단어: {item.video_glosses.join(" · ")}</> : <>동작 출처: {item.motion_take}</>}
              {item.kind === "gloss" && item.video_segment && <> · 이 단어 구간 {item.video_segment[0].toFixed(2)}~{item.video_segment[1].toFixed(2)}초</>}</p>
            {item.video_take && <div className="verdicts">
              <span>아바타 = 원본 영상?</span>
              {(["same", "different", "unsure"] as Verdict[]).map((v) => <button type="button" key={v} aria-pressed={review.avatar === v} onClick={() => save({ avatar: v })}>{VERDICT_TEXT[v]}</button>)}
            </div>}
            <div className="verdicts">
              <span>아바타 = 국립국어원 수어?</span>
              {(["same", "different", "unsure"] as Verdict[]).map((v) => <button type="button" key={v} aria-pressed={review.nikl === v} onClick={() => save({ nikl: v })}>{VERDICT_TEXT[v]}</button>)}
              <a href={`https://sldict.korean.go.kr/front/search/searchAllList.do?searchKeyword=${encodeURIComponent(item.label)}`} target="_blank" rel="noreferrer">국립국어원 수어사전에서 찾기 ↗</a>
            </div>
            <textarea placeholder="메모 (예: 오른손 손 모양이 다름, 끝부분이 잘림)" value={review.memo ?? ""} onChange={(e) => save({ memo: e.target.value })} rows={2} />
            {senses.length > 0 && <ul className="senses">{senses.map((e) => <li key={e.id}>
              <button type="button" aria-pressed={niklId === e.id} onClick={() => setNiklId(e.id)}>이 뜻 영상 보기</button>{" "}
              <a href={niklUrl(e.id)} target="_blank" rel="noreferrer"><b>수어사전 {e.id} ↗</b></a> · {e.c}{e.w.find(([w]) => w === item.label)?.[1] ? ` · (${e.w.find(([w]) => w === item.label)?.[1]})` : ""}<br />{e.h || "수형 설명 없음"}
            </li>)}</ul>}
            <div className="buttons"><button type="button" onClick={exportReviews} disabled={!Object.keys(reviews).length}>검수 결과 내려받기 (JSON)</button></div>
          </div>
        </section>}
      </div>
    </main>
  );
}
