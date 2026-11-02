import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

// 개발·검수 전용: 원본 영상 ↔ 아바타 비교표 목록 (scripts/build_video_compare.py 결과)
export async function GET() {
  if (process.env.NODE_ENV === "production") return new Response("개발 모드 전용입니다.", { status: 404 });
  try {
    const raw = await readFile(path.join(process.cwd(), "data", "video_compare.json"), "utf8");
    return new Response(raw, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "비교표가 없습니다. python scripts/build_video_compare.py 를 먼저 실행하세요." }, { status: 404 });
  }
}
