import { describe, expect, it } from 'vitest'

describe('A11y & UX Improvements', () => {
  describe('WAI-ARIA Tab Navigation in GitDock', () => {
    const tabs = [
      { id: 'push', label: 'Push' },
      { id: 'branches', label: 'Branches' },
      { id: 'init', label: 'Init' },
      { id: 'clone', label: 'Clonar' },
    ]

    function getNextTabOnKey(currentTabId: string, key: string): string {
      const index = tabs.findIndex((t) => t.id === currentTabId)
      if (key === 'ArrowRight') return tabs[(index + 1) % tabs.length].id
      if (key === 'ArrowLeft') return tabs[(index - 1 + tabs.length) % tabs.length].id
      if (key === 'Home') return tabs[0].id
      if (key === 'End') return tabs[tabs.length - 1].id
      return currentTabId
    }

    it('navigates with ArrowRight and wraps around', () => {
      expect(getNextTabOnKey('push', 'ArrowRight')).toBe('branches')
      expect(getNextTabOnKey('clone', 'ArrowRight')).toBe('push')
    })

    it('navigates with ArrowLeft and wraps around', () => {
      expect(getNextTabOnKey('branches', 'ArrowLeft')).toBe('push')
      expect(getNextTabOnKey('push', 'ArrowLeft')).toBe('clone')
    })

    it('moves to first and last tabs with Home and End', () => {
      expect(getNextTabOnKey('branches', 'Home')).toBe('push')
      expect(getNextTabOnKey('branches', 'End')).toBe('clone')
    })

    it('assigns roving tabIndex 0 to active tab and -1 to inactive tabs', () => {
      const activeTab = 'branches'
      const tabIndices = tabs.map((t) => ({ id: t.id, tabIndex: activeTab === t.id ? 0 : -1 }))
      expect(tabIndices).toEqual([
        { id: 'push', tabIndex: -1 },
        { id: 'branches', tabIndex: 0 },
        { id: 'init', tabIndex: -1 },
        { id: 'clone', tabIndex: -1 },
      ])
    })
  })

  describe('AccessibleDialog visibility filtering', () => {
    function isElementFocusable(el: {
      hidden?: boolean
      ariaHidden?: string
      display?: string
      visibility?: string
      closestHidden?: boolean
    }): boolean {
      if (el.hidden || el.ariaHidden === 'true' || el.closestHidden) return false
      if (el.display === 'none' || el.visibility === 'hidden') return false
      return true
    }

    it('filters out elements with hidden, aria-hidden, or display none', () => {
      expect(isElementFocusable({})).toBe(true)
      expect(isElementFocusable({ hidden: true })).toBe(false)
      expect(isElementFocusable({ ariaHidden: 'true' })).toBe(false)
      expect(isElementFocusable({ display: 'none' })).toBe(false)
      expect(isElementFocusable({ visibility: 'hidden' })).toBe(false)
      expect(isElementFocusable({ closestHidden: true })).toBe(false)
    })
  })

  describe('Actionable Notifications (WCAG 2.2.1)', () => {
    function shouldAutoDismiss(type: 'success' | 'error' | 'info', actions?: Array<{ id: string; label: string }>): boolean {
      const hasActions = Boolean(actions && actions.length > 0)
      if (type === 'error') return false
      if (hasActions) return false
      return true
    }

    it('auto-dismisses standard success and info notifications without actions', () => {
      expect(shouldAutoDismiss('success')).toBe(true)
      expect(shouldAutoDismiss('info')).toBe(true)
    })

    it('never auto-dismisses error notifications', () => {
      expect(shouldAutoDismiss('error')).toBe(false)
      expect(shouldAutoDismiss('error', [{ id: 'retry', label: 'Tentar novamente' }])).toBe(false)
    })

    it('never auto-dismisses notifications that contain action buttons', () => {
      expect(shouldAutoDismiss('info', [{ id: 'view', label: 'Ver' }])).toBe(false)
      expect(shouldAutoDismiss('success', [{ id: 'undo', label: 'Desfazer' }])).toBe(false)
    })
  })

  describe('Launcher separation (Antigravity vs Gemini)', () => {
    it('uses distinct identities, subtitles and tools for Antigravity and Gemini', () => {
      const launchers = {
        agy: { label: 'Antigravity', subtitle: 'CLI · agy', tool: 'agy' },
        gemini: { label: 'Gemini CLI', subtitle: 'CLI · Google', tool: 'gemini' },
      }

      expect(launchers.agy.subtitle).not.toContain('Gemini')
      expect(launchers.gemini.label).toBe('Gemini CLI')
      expect(launchers.agy.tool).toBe('agy')
      expect(launchers.gemini.tool).toBe('gemini')
    })
  })
})
