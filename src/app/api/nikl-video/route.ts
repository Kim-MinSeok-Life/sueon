export const runtime = "nodejs";

// 개발·검수 전용: 국립국어원 한국수어사전 표준 영상 주소 찾기.
// 사전 항목 화면(origin_no)에 있는 미리보기 그림 주소(…_105X105.jpg)를 같은 이름의 영상 주소(…_700X466.mp4)로 바꾼다.
// 영상은 복사·저장하지 않고, 검수 화면이 국립국어원 서버의 영상을 바로 재생한다. 한 번 찾은 주소는 서버가 켜져 있는 동안만 기억한다.
const BASE = "https://sldict.korean.go.kr";
const cache = new Map<number, string | null>();

export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production") return new Response("개발 모드 전용입니다.", { status: 404 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "id(수어사전 번호)가 필요합니다." }, { status: 400 });
  const page = `${BASE}/front/sign/signContentsView.do?origin_no=${id}&top_category=CTE`;
  if (!cache.has(id)) {
    try {
      const html = await (await fetch(page, { signal: AbortSignal.timeout(10_000) })).text();
      const m = html.match(/(multimedia\/multimedia_files\/convert\/[^"'\s]+?\/MOV\d+)_105X105\.jpg/);
      cache.set(id, m ? `${BASE}/${m[1]}_700X466.mp4` : null);
    } catch {
      return Response.json({ error: "국립국어원 사전에 연결하지 못했습니다.", page }, { status: 502 });
    }
  }
  const video = cache.get(id);
  return Response.json(video ? { id, video, page } : { id, video: null, page, error: "이 항목에는 영상이 없습니다." });
}
