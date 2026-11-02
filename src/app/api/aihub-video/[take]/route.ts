import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

// 개발·검수 전용: AI-Hub 원본 영상은 배포 권한이 없으므로 운영 모드에서는 항상 막는다.
// 영상을 복사하지 않고, 무압축 ZIP 안의 바이트 구간을 그대로 읽어 보낸다(위치는 scripts/build_video_compare.py가 기록).
const MANIFEST = path.join(process.cwd(), "data", "video_compare.json");
const TAKE_RE = /^NIA_SL_(SEN|WORD)\d{4}_REAL\d{2}_[FUDLR]$/;

type VideoLoc = { zip: string; entry: string; offset: number; size: number };

async function locate(take: string): Promise<VideoLoc | null> {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as { items: { video_take: string; video: VideoLoc }[] };
  return manifest.items.find((i) => i.video_take === take)?.video ?? null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ take: string }> }) {
  if (process.env.NODE_ENV === "production") return new Response("개발 모드 전용입니다.", { status: 404 });
  const { take } = await params;
  if (!TAKE_RE.test(take)) return new Response("잘못된 촬영본 이름입니다.", { status: 400 });
  let loc: VideoLoc | null;
  try {
    loc = await locate(take);
  } catch {
    return new Response("비교표가 없습니다. python scripts/build_video_compare.py 를 먼저 실행하세요.", { status: 404 });
  }
  if (!loc) return new Response("이 촬영본의 영상이 비교표에 없습니다.", { status: 404 });

  const zipPath = path.isAbsolute(loc.zip) ? loc.zip : path.join(process.cwd(), loc.zip);
  // 브라우저 영상 재생은 구간(Range) 요청으로 앞뒤를 오가므로 206 응답을 지원한다
  let start = 0;
  let end = loc.size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range) {
    if (range[1]) start = Number(range[1]);
    if (range[2]) end = Math.min(Number(range[2]), loc.size - 1);
    if (!range[1] && range[2]) [start, end] = [Math.max(0, loc.size - Number(range[2])), loc.size - 1];
    if (start > end || start >= loc.size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${loc.size}` } });
    }
  }
  const stream = createReadStream(zipPath, { start: loc.offset + start, end: loc.offset + end });
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    "Cache-Control": "private, max-age=3600",
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${loc.size}`;
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers });
}
