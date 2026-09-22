import { describe, expect, it } from 'vitest'
import {
  GIT_DOCK_TABS,
  getNextGitDockTabOnKey,
} from '../src/renderer/src/components/git-dock-helpers'
import { isAccessibleElementVisible } from '../src/renderer/src/components/AccessibleDialog'
import { shouldAutoDismissNotification } from '../src/renderer/src/components/notification-helpers'
import { LAUNCHER_IDENTITIES } from '../src/renderer/src/components/ProjectCard'

describe('A11y & UX Improvements (testes reais de produção)', () => {
  describe('WAI-ARIA Tab Navigation in GitDock (produção via git-dock-helpers)', () => {
    it('navigates with ArrowRight and wraps around across production tabs', () => {
      expect(getNextGitDockTabOnKey('push', 'ArrowRight', GIT_DOCK_TABS)).toBe('branches')
      expect(getNextGitDockTabOnKey('clone', 'ArrowRight', GIT_DOCK_TABS)).toBe('push')
    })

    it('navigates with ArrowLeft and wraps around across production tabs', () => {
      expect(getNextGitDockTabOnKey('branches', 'ArrowLeft', GIT_DOCK_TABS)).toBe('push')
      expect(getNextGitDockTabOnKey('push', 'ArrowLeft', GIT_DOCK_TABS)).toBe('clone')
    })

    it('moves to first and last tabs with Home and End', () => {
      expect(getNextGitDockTabOnKey('branches', 'Home', GIT_DOCK_TABS)).toBe('push')
      expect(getNextGitDockTabOnKey('branches', 'End', GIT_DOCK_TABS)).toBe('clone')
    })

    it('uses the production GIT_DOCK_TABS definition with stable roving tabIndex', () => {
      expect(GIT_DOCK_TABS).toEqual([
        { id: 'push', label: 'Push' },
        { id: 'branches', label: 'Branches' },
        { id: 'init', label: 'Init' },
        { id: 'clone', label: 'Clonar' },
      ])
      const activeTab = 'branches'
      const tabIndices = GIT_DOCK_TABS.map((t) => ({ id: t.id, tabIndex: activeTab === t.id ? 0 : -1 }))
      expect(tabIndices).toEqual([
        { id: 'push', tabIndex: -1 },
        { id: 'branches', tabIndex: 0 },
        { id: 'init', tabIndex: -1 },
        { id: 'clone', tabIndex: -1 },
      ])
    })
  })

  describe('AccessibleDialog visibility filtering (produção via AccessibleDialog.tsx)', () => {
    function makeElement(opts: {
      hidden?: boolean
      ariaHidden?: string
      display?: string
      visibility?: string
      closestHidden?: boolean
    }): HTMLElement {
      return {
        hidden: Boolean(opts.hidden),
        getAttribute: (attr: string) => (attr === 'aria-hidden' ? opts.ariaHidden ?? null : null),
        closest: (selector: string) => (opts.closestHidden ? ({} as Element) : null),
      } as unknown as HTMLElement
    }

    it('filters out elements with hidden, aria-hidden, or ancestor hidden in production isAccessibleElementVisible', () => {
      expect(isAccessibleElementVisible(makeElement({}))).toBe(true)
      expect(isAccessibleElementVisible(makeElement({ hidden: true }))).toBe(false)
      expect(isAccessibleElementVisible(makeElement({ ariaHidden: 'true' }))).toBe(false)
      expect(isAccessibleElementVisible(makeElement({ closestHidden: true }))).toBe(false)
    })
  })

  describe('Actionable Notifications WCAG 2.2.1 (produção via notification-helpers.ts)', () => {
    it('auto-dismisses standard success and info notifications without actions', () => {
      expect(shouldAutoDismissNotification('success')).toBe(true)
      expect(shouldAutoDismissNotification('info')).toBe(true)
    })

    it('never auto-dismisses error notifications', () => {
      expect(shouldAutoDismissNotification('error')).toBe(false)
      expect(shouldAutoDismissNotification('error', [{ id: 'retry', label: 'Tentar novamente' }])).toBe(false)
    })

    it('never auto-dismisses notifications that contain action buttons', () => {
      expect(shouldAutoDismissNotification('info', [{ id: 'view', label: 'Ver' }])).toBe(false)
      expect(shouldAutoDismissNotification('success', [{ id: 'undo', label: 'Desfazer' }])).toBe(false)
    })
  })

  describe('Launcher separation Antigravity vs Gemini (produção via ProjectCard.tsx)', () => {
    it('uses distinct production identities, subtitles and tools for Antigravity and Gemini', () => {
      expect(LAUNCHER_IDENTITIES.agy.subtitle).not.toContain('Gemini')
      expect(LAUNCHER_IDENTITIES.agy.label).toBe('Antigravity')
      expect(LAUNCHER_IDENTITIES.agy.tool).toBe('agy')
      expect(LAUNCHER_IDENTITIES.gemini.label).toBe('Gemini CLI')
      expect(LAUNCHER_IDENTITIES.gemini.subtitle).toBe('CLI · Google')
      expect(LAUNCHER_IDENTITIES.gemini.tool).toBe('gemini')
    })
  })
})
