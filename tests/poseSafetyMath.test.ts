import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyEscapeLocal, WRIST_SWING_LIMIT_DEG, WRIST_TWIST_LIMIT_DEG } from "../src/lib/poseSafetyMath.ts";

const radius = { x: 0.18, y: 0.26, z: 0.12 };
function inside(p: {x:number,y:number,z:number}) {
  return (p.x / radius.x) ** 2 + (p.y / radius.y) ** 2 + (p.z / radius.z) ** 2 < 1 - 1e-6;
}
test("몸통 내부 정면 손목을 몸통 바깥으로 보정한다", () => {
  const p = { x: 0.01, y: 0, z: 0.025 };
  const d = bodyEscapeLocal(p, radius);
  assert.ok(d);
  assert.equal(d.y, 0);
  assert.equal(d.x, 0);
  assert.equal(inside({ x:p.x+d.x, y:p.y+d.y, z:p.z+d.z }), false);
});
test("몸통 측면에 가까운 손은 측면으로 최소한 이동한다", () => {
  const p = { x: 0.16, y: 0, z: 0.01 };
  const d = bodyEscapeLocal(p, radius);
  assert.ok(d);
  assert.ok(d.x > 0);
  assert.equal(d.z, 0);
  assert.equal(inside({ x:p.x+d.x, y:p.y+d.y, z:p.z+d.z }), false);
});
test("몸통 밖과 경계에서는 관절을 변경하지 않는다", () => {
  assert.equal(bodyEscapeLocal({ x: 0, y: 0, z: -0.13 }, radius), null);
  assert.equal(bodyEscapeLocal({ x: 0, y: 0.29, z: 0 }, radius), null);
  assert.equal(bodyEscapeLocal({ x: 0, y: 0, z: 0.12 }, radius), null);
});
test("비정상 입력은 보정 대상에서 제외한다", () => {
  assert.equal(bodyEscapeLocal({ x: NaN, y: 0, z: 0 }, radius), null);
  assert.equal(bodyEscapeLocal({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 1 }), null);
});
test("손목 회전 제한 상수는 전 범위에서 유효하다", () => {
  assert.ok(WRIST_SWING_LIMIT_DEG > 0 && WRIST_SWING_LIMIT_DEG < 90);
  assert.ok(WRIST_TWIST_LIMIT_DEG > 0 && WRIST_TWIST_LIMIT_DEG < 90);
});
