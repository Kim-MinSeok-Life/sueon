import { NextResponse, type NextRequest } from "next/server";

// 공개 배포 권한을 확인하지 않은 AI-Hub 파생 모션은 기본적으로 외부 접근을 막는다.
// 이 파일은 Next.js 16의 proxy 규약을 따른다.
export function proxy(_request: NextRequest) {
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_SUEON_ALLOW_SAMPLE_PUBLIC !== "true") {
    return new NextResponse("AI-Hub 파생 모션은 외부 배포 권한 검증 전입니다.", { status: 403 });
  }
  return NextResponse.next();
}
export const config = { matcher: ["/motions/sample/:path*", "/motions/stabilized/:path*", "/motions/aihub_real02/:path*", "/motions/aihub_gloss/:path*"] };
