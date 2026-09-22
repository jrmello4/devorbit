import React, { useEffect, useRef } from 'react'

interface AccessibleDialogProps {
  isOpen: boolean
  titleId: string
  onClose: () => void
  children: React.ReactNode
  className?: string
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function isAccessibleElementVisible(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
  if (element.closest('[aria-hidden="true"], [hidden]')) return false
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

/**
 * Lightweight dialog primitive for the Electron renderer.
 * It keeps the existing visual overlay while providing modal semantics,
 * focus containment/restoration, Escape handling and inert background content.
 */
export const AccessibleDialog: React.FC<AccessibleDialogProps> = ({
  isOpen,
  titleId,
  onClose,
  children,
  className = '',
}) => {
  const overlayRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!isOpen) return

    const previousFocus = document.activeElement as HTMLElement | null
    const overlay = overlayRef.current
    const panel = panelRef.current
    if (!overlay || !panel) return

    const parent = overlay.parentElement
    const inertSiblings: Array<{ element: HTMLElement; inert: boolean }> = []
    if (parent) {
      Array.from(parent.children).forEach((child) => {
        if (child === overlay || !(child instanceof HTMLElement)) return
        const element = child as HTMLElement & { inert?: boolean }
        inertSiblings.push({ element, inert: Boolean(element.inert) })
        element.inert = true
      })
    }

    const focusInitialElement = () => {
      const preferred = panel.querySelector<HTMLElement>('[autofocus]')
      const validPreferred = preferred && isAccessibleElementVisible(preferred) ? preferred : null
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isAccessibleElementVisible)
      const firstFocusable = focusable[0] || null
      ;(validPreferred || firstFocusable || panel).focus()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab') return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isAccessibleElementVisible)
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    const focusFrame = window.requestAnimationFrame(focusInitialElement)

    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      inertSiblings.forEach(({ element, inert }) => {
        element.inert = inert
      })
      // React removes the active element after effect cleanup. Restoring in
      // the next frame keeps the origin focused after the dialog has left DOM.
      window.requestAnimationFrame(() => {
        if (previousFocus && document.contains(previousFocus)) previousFocus.focus()
      })
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4"
      data-dialog-overlay="true"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`overscroll-contain text-[13px] max-h-[calc(100dvh-48px)] ${className}`}
      >
        {children}
      </div>
    </div>
  )
}
