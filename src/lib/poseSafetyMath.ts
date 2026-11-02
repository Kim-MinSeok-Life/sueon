/**
 * 몸통을 타원체로 근사해 손목이 내부에 들어온 경우의 최소 바깥쪽 변위를 구한다.
 * 실제 메시와의 정밀 충돌 판정은 아니다. 수어에서 몸 접촉이 의미를 가질 수 있으므로
 * 별도의 시연용 보정에만 사용한다.
 */
export interface Vec3Like { x: number; y: number; z: number }
export interface BodyRadii { x: number; y: number; z: number }

export function bodyEscapeLocal(
  p: Vec3Like,
  radius: BodyRadii,
  clearance = 0.012,
): Vec3Like | null {
  if (![p.x, p.y, p.z, radius.x, radius.y, radius.z, clearance].every(Number.isFinite)) return null;
  if (radius.x <= 0 || radius.y <= 0 || radius.z <= 0 || clearance < 0) return null;
  const yTerm = (p.y / radius.y) ** 2;
  if (yTerm >= 1) return null;
  const xTerm = (p.x / radius.x) ** 2;
  const zTerm = (p.z / radius.z) ** 2;
  const remaining = 1 - yTerm;
  if (xTerm + zTerm >= remaining) return null;

  // 동일한 높이에서 X/Z 두 방향의 출구를 비교한다. 몸통을 관통하는
  // 순간에도 다른 방향으로 갑자기 튀지 않도록 현재 위치의 부호를 유지한다.
  const surfaceX = radius.x * Math.sqrt(Math.max(0, remaining - zTerm));
  const surfaceZ = radius.z * Math.sqrt(Math.max(0, remaining - xTerm));
  const escapeX = Math.max(0, surfaceX + clearance - Math.abs(p.x));
  const escapeZ = Math.max(0, surfaceZ + clearance - Math.abs(p.z));
  // 몸 앞뒤가 열린 경로를 우선하되, 측면 출구가 명백히 더 가까울 때는 측면으로 보정한다.
  if (escapeX < escapeZ * 0.7) return { x: (p.x < 0 ? -1 : 1) * escapeX, y: 0, z: 0 };
  return { x: 0, y: 0, z: (p.z < 0 ? -1 : 1) * escapeZ };
}

export const WRIST_SWING_LIMIT_DEG = 70;
export const WRIST_TWIST_LIMIT_DEG = 75;
export const MAX_UPPER_ARM_DEVIATION_DEG = 28;
export const MAX_LOWER_ARM_DEVIATION_DEG = 35;
