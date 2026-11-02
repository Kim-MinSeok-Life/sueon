"""
브라우저 자동 테스트: 텍스트 입력 → 매칭 → 동작 로드 → 아바타 관절이 실제로 회전하는지 확인.

정규화 본(코드가 직접 쓰는 값)이 아니라 실제 메시를 움직이는 스킨 본(raw bone)의
월드 회전을 재생 중 반복 측정해, 최대 회전 변화량(도)을 기준값과 비교한다.

준비:  pip install playwright && python -m playwright install chromium
실행:  npm run build && npm start   (다른 터미널에서)
       python tests/e2e_avatar.py [http://localhost:3000]
"""
import asyncio
import math
import sys

from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
MIN_DEG = 30.0  # 이 이상 회전해야 "관절이 움직였다"고 판정
results: list[tuple[bool, str]] = []


def check(ok: bool, msg: str):
    results.append((ok, msg))
    print(("PASS " if ok else "FAIL ") + msg)


def angle_deg(a, b):
    dot = abs(sum(x * y for x, y in zip(a, b)))
    return math.degrees(2 * math.acos(min(1.0, dot)))


async def submit(pg, text):
    await pg.fill("#sentence", text)
    await pg.click("button[type=submit]")
    await pg.wait_for_selector(".segments")


async def measure(pg, bones, timeout_s=240):
    """동작 재생이 끝날 때까지 본 회전을 샘플링해 본별 최대 변화량(도)을 반환.
    느린 환경(GPU 없는 CI 등)에서는 재생 속도가 느려지므로 실제 시간이 아니라 재생 완료를 기준으로 한다."""
    first = {b: await pg.evaluate("b => window.__SUEON__.rawWorldQuat(b)", b) for b in bones}
    peak = {b: 0.0 for b in bones}
    loop = asyncio.get_event_loop()
    end = loop.time() + timeout_s
    while loop.time() < end:
        for b in bones:
            q = await pg.evaluate("b => window.__SUEON__.rawWorldQuat(b)", b)
            peak[b] = max(peak[b], angle_deg(first[b], q))
        if await pg.evaluate("window.__SUEON__.playerState().status") == "idle":
            break
        await pg.wait_for_timeout(250)
    return peak


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        )
        pg = await browser.new_page(viewport={"width": 1280, "height": 900})
        page_errors = []
        pg.on("pageerror", lambda e: page_errors.append(str(e)))

        await pg.goto(f"{BASE}/?debug=1")
        await pg.wait_for_function("window.__SUEON__ && window.__SUEON__.ready", timeout=90000)
        fingers = await pg.evaluate("window.__SUEON__.fingerBones")
        check(len(fingers) == 30, f"아바타 로드 및 손가락 본 {len(fingers)}개 확인 (기대 30)")

        check(await pg.locator(".data-notice").count() == 0, "개발 공지 배너가 사용자 화면에서 제거됨")
        check(await pg.locator(".dev-tools").count() == 1, "개발 URL에서만 실험 도구 표시")

        # 1) 등록됐지만 데이터 없는 표현: 재생하지 않아야 함
        await submit(pg, "안녕하세요")
        badge = await pg.inner_text(".seg .badge")
        await pg.wait_for_timeout(500)
        st = await pg.evaluate("window.__SUEON__.playerState().status")
        check("준비 중" in badge and st == "idle", f"'안녕하세요' → '{badge}', 재생 상태 {st}")
        bubble = await pg.inner_text(".bubble")
        check("안녕하세요" in bubble, "입력 문장이 말풍선에 유지됨")

        # 2) 미지원 표현: 다른 동작으로 대체하지 않음
        await submit(pg, "안녕히 가세요")
        badges = await pg.locator(".seg .badge").all_inner_texts()
        await pg.wait_for_timeout(500)
        st = await pg.evaluate("window.__SUEON__.playerState().status")
        check(all("미지원" in b for b in badges) and st == "idle", f"'안녕히 가세요' → {badges}, 재생 상태 {st}")

        # 3) 손가락 테스트 동작: 실제 스킨 본이 회전해야 함
        await submit(pg, "#손가락테스트")
        await pg.wait_for_function("window.__SUEON__.playerState().status==='playing'")
        flag = await pg.inner_text(".test-flag")
        check("한국수어 아님" in flag, f"테스트 동작 경고 표시: '{flag}'")
        peak = await measure(pg, ["leftIndexProximal", "rightIndexProximal", "leftLittleIntermediate", "leftThumbProximal"])
        for bone, deg in peak.items():
            check(deg >= MIN_DEG, f"#손가락테스트 {bone} 최대 회전 {deg:.1f}°")

        # 4) 다시 재생
        await pg.get_by_role("button", name="↺ 다시 재생").click()
        await pg.wait_for_timeout(300)
        st = await pg.evaluate("window.__SUEON__.playerState().status")
        check(st == "playing", f"다시 재생 버튼 → 상태 {st}")

        # 5) 팔·손목 테스트 동작
        await submit(pg, "#팔테스트")
        await pg.wait_for_function("window.__SUEON__.playerState().status==='playing'")
        peak = await measure(pg, ["rightUpperArm", "rightLowerArm", "rightHand", "leftLowerArm"])
        for bone, deg in peak.items():
            check(deg >= MIN_DEG, f"#팔테스트 {bone} 최대 회전 {deg:.1f}°")

        # AI-Hub 원본 3D 좌표에서 생성한 검증 전 클립도 로드 및 관절 회전을 확인한다.
        await submit(pg, "#WORD1501")
        await pg.wait_for_function("window.__SUEON__.playerState().status==='playing'")
        sample = await measure(pg, ["rightUpperArm", "leftLowerArm"], timeout_s=90)
        check(max(sample.values()) >= 10, f"AI-Hub 유래 실험 모션 관절 회전 관측: {sample}")

        # 실제 뜻이 확인된 표제어라도 움직임 자체는 미검증인 데모로만 재생된다.
        await submit(pg, "운전면허")
        await pg.wait_for_function("window.__SUEON__.playerState().status==='playing'")
        labels = await pg.locator(".seg-word").all_inner_texts()
        check(any("운전면허" in label for label in labels), f"표제어 운전면허 연결: {labels}")
        check("정확도 미검증" in await pg.inner_text(".seg .badge"), "정확도 미검증 상태 표시")

        # 일반 사용자 모드는 복잡한 실험용 항목을 보여주지 않는다.
        public_pg = await browser.new_page(viewport={"width": 320, "height": 645}, device_scale_factor=1)
        public_errors = []
        public_pg.on("pageerror", lambda e: public_errors.append(str(e)))
        await public_pg.goto(BASE)
        await public_pg.wait_for_selector("#sentence")
        check(await public_pg.locator(".dev-tools").count() == 0, "일반 화면에서 관절 실험 도구 숨김")
        check(await public_pg.locator(".data-notice, .insight-card, .credit, .prototype-tag").count() == 0, "개발 문구 제거")
        overflows = await public_pg.evaluate("document.documentElement.scrollWidth > window.innerWidth + 2")
        check(not overflows, "320px 화면에서 가로 스크롤이 발생하지 않음")
        public_pg.locator("#sentence")
        await public_pg.fill("#sentence", "안녕하세요")
        await public_pg.get_by_role("button", name="수어로 보기").click()
        check("준비 중" in (await public_pg.inner_text(".seg .badge")), "검증 전 수어를 재생 가능하다고 표시하지 않음")
        check(not public_errors, f"모바일 페이지 런타임 오류 {len(public_errors)}건")
        check(not page_errors, f"페이지 런타임 오류 {len(page_errors)}건 {page_errors[:2]}")
        await public_pg.close()
        await browser.close()

    failed = [m for ok, m in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} 통과")
    sys.exit(1 if failed else 0)


asyncio.run(main())
