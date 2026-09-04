# Agent Note: Mobile web composer and sidebar use compact controls

Status: implemented

English | [中文](2026-09-05-mobile-web-composer-and-sidebar.zh.md)

## Problem

The web composer added attachment actions without accounting for narrow browser widths. The expanded picker could overlap the composer, and a collapsed mobile sidebar still reserved a desktop rail that reduced the conversation viewport.

## Decision

On narrow viewports, a collapsed sidebar occupies zero layout columns and renders one fixed, safe-area-aware reopen button. Desktop retains the compact rail so existing pointer and keyboard behavior remains unchanged.

The composer owns one attachment picker in its attachment slot. The picker opens a bottom sheet on mobile, invokes native file inputs directly from the user gesture, and resets each input after selection so the same file can be chosen again. File and photo inputs remain accessible through localized labels and keyboard focus restoration.

## Alternatives considered

**Keep the compact desktop rail on mobile.** The hidden rail would continue to reduce the conversation viewport while offering controls unavailable in the collapsed state.

**Keep the attachment picker inline with the composer.** Its expanded actions would compete with message submission controls and could extend beyond a narrow viewport.

## Consequences

Mobile attachment actions stay inside the viewport and no longer compete with the message submit controls. The sidebar content is removed from the mobile layout when closed, while the fixed reopen control remains available above the conversation. Upload failures remain owned by the composer; the picker only releases its busy state.

## Verification

The focused attachment, conversation, layout, sidebar, and elevation suites pass with 167 tests. Repository typecheck and the GUI test suite pass. Web snapshot replay remains a named coverage gap because the file-tree baseline has failures outside this UI change.
