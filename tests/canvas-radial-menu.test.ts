import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Plus } from 'lucide-react'
import {
  RADIAL_MENU_BASE_COUNT,
  RADIAL_MENU_DEFAULTS,
  nearestRadialIndex,
  radialItemAngle,
  radialItemAngles,
  radialPointFromAngle,
  radialStaggerDelay,
  resolveRadialRadius,
} from '../src/renderer/src/components/radial-menu-helpers'
import { CanvasRadialMenu } from '../src/renderer/src/components/CanvasRadialMenu'
import type { CanvasRadialItem } from '../src/renderer/src/components/CanvasRadialMenu'

describe('radial-menu-helpers — Menu radial do canvas', () => {
  it('expõe os defaults congelados', () => {
    expect(RADIAL_MENU_DEFAULTS).toEqual({ radius: 74, spread: 185, stagger: 42 })
    expect(RADIAL_MENU_BASE_COUNT).toBe(5)
  })

  describe('radialItemAngle', () => {
    it('retorna -90 quando há um item ou menos', () => {
      expect(radialItemAngle(0, 1, 185)).toBe(-90)
      expect(radialItemAngle(0, 0, 185)).toBe(-90)
    })

    it('centraliza o arco para cima com passos iguais', () => {
      expect(radialItemAngle(0, 5, 185)).toBeCloseTo(-182.5, 9)
      expect(radialItemAngle(2, 5, 185)).toBeCloseTo(-90, 9)
      expect(radialItemAngle(4, 5, 185)).toBeCloseTo(2.5, 9)
      expect(radialItemAngle(0, 6, 185)).toBeCloseTo(-182.5, 9)
      expect(radialItemAngle(3, 6, 185)).toBeCloseTo(-71.5, 9)
      expect(radialItemAngle(5, 6, 185)).toBeCloseTo(2.5, 9)
    })

    it('mantém simetria em torno de -90', () => {
      const angles = radialItemAngles(6, 185)
      angles.forEach((angle, index) => {
        expect(angle + angles[angles.length - 1 - index]).toBeCloseTo(-180, 9)
      })
    })
  })

  describe('radialItemAngles', () => {
    it('produz um ângulo por item', () => {
      expect(radialItemAngles(4, 120)).toEqual([-150, -110, -70, -30])
    })

    it('retorna lista vazia para count <= 0', () => {
      expect(radialItemAngles(0, 185)).toEqual([])
      expect(radialItemAngles(-2, 185)).toEqual([])
    })
  })

  describe('resolveRadialRadius', () => {
    it('não altera o raio com um item ou menos', () => {
      expect(resolveRadialRadius(74, 1, 185)).toBe(74)
      expect(resolveRadialRadius(74, 0, 185)).toBe(74)
    })

    it('mantém o raio no count base', () => {
      expect(resolveRadialRadius(74, RADIAL_MENU_BASE_COUNT, 185)).toBe(74)
    })

    it('compensa para cima acima do count base', () => {
      const compensated = resolveRadialRadius(74, 6, 185)
      expect(compensated).toBeGreaterThan(74)
      expect(compensated).toBeCloseTo(
        74 * (Math.sin((23.125 * Math.PI) / 180) / Math.sin((18.5 * Math.PI) / 180)),
        9,
      )
      expect(resolveRadialRadius(74, 12, 185)).toBeGreaterThan(compensated)
    })

    it('aplica piso 1 quando a compensação encolheria o raio', () => {
      expect(resolveRadialRadius(74, 4, 185)).toBe(74)
    })

    it('respeita um baseCount customizado', () => {
      expect(resolveRadialRadius(74, 7, 185, 7)).toBe(74)
    })

    it('mantém a corda entre itens maior que o botão de 48px', () => {
      for (let count = 2; count <= 10; count += 1) {
        const radius = resolveRadialRadius(74, count, 185)
        const step = (185 / (count - 1)) * (Math.PI / 180)
        const chord = 2 * radius * Math.sin(step / 2)
        expect(chord).toBeGreaterThan(48)
      }
    })
  })

  describe('radialStaggerDelay', () => {
    it('escalona apenas na abertura', () => {
      expect(radialStaggerDelay(0, 42, true)).toBe(0)
      expect(radialStaggerDelay(3, 42, true)).toBe(126)
      expect(radialStaggerDelay(3, 42, false)).toBe(0)
    })
  })

  describe('radialPointFromAngle', () => {
    it('aponta para cima em -90 graus', () => {
      const point = radialPointFromAngle(-90, 74)
      expect(point.x).toBeCloseTo(0, 9)
      expect(point.y).toBeCloseTo(-74, 9)
    })

    it('resolve os eixos principais', () => {
      const right = radialPointFromAngle(0, 50)
      expect(right.x).toBeCloseTo(50, 9)
      expect(right.y).toBeCloseTo(0, 9)
      const left = radialPointFromAngle(180, 50)
      expect(left.x).toBeCloseTo(-50, 9)
      expect(radialPointFromAngle(-180, 50).x).toBeCloseTo(-50, 9)
      expect(radialPointFromAngle(90, 50).y).toBeCloseTo(50, 9)
    })
  })

  describe('nearestRadialIndex', () => {
    const angles = radialItemAngles(6, 185)
    const direction = (deg: number) => {
      const radians = deg * (Math.PI / 180)
      return { dx: Math.cos(radians) * 100, dy: Math.sin(radians) * 100 }
    }

    it('seleciona o item alinhado à direção do ponteiro', () => {
      const right = direction(2.5)
      expect(nearestRadialIndex(right.dx, right.dy, angles)).toBe(5)
      const upRight = direction(-34.5)
      expect(nearestRadialIndex(upRight.dx, upRight.dy, angles)).toBe(4)
    })

    it('mede distância circular com wrap perto de 180 graus', () => {
      const left = direction(-182.5)
      expect(nearestRadialIndex(left.dx, left.dy, angles)).toBe(0)
      const nearLeft = direction(177.5)
      expect(nearestRadialIndex(nearLeft.dx, nearLeft.dy, angles)).toBe(0)
    })

    it('ignora itens desabilitados', () => {
      const right = direction(2.5)
      const allowed = [true, true, true, true, true, false]
      expect(nearestRadialIndex(right.dx, right.dy, angles, allowed)).toBe(4)
    })

    it('retorna -1 quando todos estão desabilitados', () => {
      const right = direction(0)
      const allowed = angles.map(() => false)
      expect(nearestRadialIndex(right.dx, right.dy, angles, allowed)).toBe(-1)
    })

    it('retorna -1 para lista de ângulos vazia', () => {
      expect(nearestRadialIndex(10, -10, [])).toBe(-1)
    })
  })
})

describe('CanvasRadialMenu — estrutura renderizada', () => {
  it('renderiza a árvore acessível com itens, item desabilitado e core', () => {
    const items: CanvasRadialItem[] = [
      { id: 'note', label: 'Nota', icon: Plus, onSelect: () => {} },
      {
        id: 'agent',
        label: 'Agente',
        icon: Plus,
        disabled: true,
        disabledReason: 'Indisponível agora',
        onSelect: () => {},
      },
      { id: 'terminal', label: 'Terminal', icon: Plus, onSelect: () => {} },
    ]

    const html = renderToStaticMarkup(createElement(CanvasRadialMenu, { items }))

    expect(html).toContain('data-canvas-radial')
    expect(html.match(/data-canvas-radial-core/g)).toHaveLength(1)
    expect(html.match(/data-canvas-radial-item=/g)).toHaveLength(3)
    expect(html.match(/role="menuitem"/g)).toHaveLength(3)
    expect(html).toContain('role="menu"')
    expect(html).toContain('aria-label="Menu do canvas"')
    expect(html).toContain('aria-expanded="false"')
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(1)
    expect(html).toContain('title="Indisponível agora"')
    expect(html.indexOf('aria-disabled="true"')).toBeGreaterThan(
      html.indexOf('data-canvas-radial-item="agent"'),
    )
    expect(html).not.toContain('data-open="true"')
    expect(html).toContain('inert=""')
    expect(html.match(/translate\(0px, 0px\) scale\(0\.4\)/g)).toHaveLength(3)
  })
})
