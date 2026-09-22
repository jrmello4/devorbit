export interface RadialMenuTuning {
  radius: number
  spread: number
  stagger: number
}

export const RADIAL_MENU_DEFAULTS: RadialMenuTuning = { radius: 74, spread: 185, stagger: 42 }

export const RADIAL_MENU_BASE_COUNT = 5

export function radialItemAngle(index: number, count: number, spread: number): number {
  if (count <= 1) return -90
  return -90 - spread / 2 + (spread / (count - 1)) * index
}

export function radialItemAngles(count: number, spread: number): number[] {
  const angles: number[] = []
  for (let index = 0; index < count; index += 1) {
    angles.push(radialItemAngle(index, count, spread))
  }
  return angles
}

export function resolveRadialRadius(
  radius: number,
  count: number,
  spread: number,
  baseCount = RADIAL_MENU_BASE_COUNT,
): number {
  if (count <= 1) return radius
  const baseHalfStep = (spread / (baseCount - 1) / 2) * (Math.PI / 180)
  const halfStep = (spread / (count - 1) / 2) * (Math.PI / 180)
  return radius * Math.max(1, Math.sin(baseHalfStep) / Math.sin(halfStep))
}

export function radialStaggerDelay(index: number, stagger: number, open: boolean): number {
  return open ? index * stagger : 0
}

export function radialPointFromAngle(angleDeg: number, radius: number): { x: number; y: number } {
  const radians = angleDeg * (Math.PI / 180)
  return { x: Math.cos(radians) * radius, y: Math.sin(radians) * radius }
}

export function nearestRadialIndex(
  dx: number,
  dy: number,
  angles: number[],
  allowed?: boolean[],
): number {
  if (!angles.length) return -1
  const target = Math.atan2(dy, dx) * (180 / Math.PI)
  let nearest = -1
  let nearestDistance = Infinity
  for (let index = 0; index < angles.length; index += 1) {
    if (allowed?.[index] === false) continue
    const diff = Math.abs(angles[index] - target)
    const distance = 180 - Math.abs((diff % 360) - 180)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = index
    }
  }
  return nearest
}
