# Agent Note: Place the sidebar file tree above Settings

Status: proposed

English | [中文](2026-08-28-sidebar-file-tree-footer-order.zh.md)

## Problem

The expanded sidebar renders the `sidebar.filetree` band before `sidebar.footer.action`, while `sidebar.settings` remains last. Deployments that add application shortcuts through the footer-action slot therefore show File first, followed by the application shortcuts, then Settings. Users scanning application destinations expect those shortcuts first and the filesystem utility beside the fixed Settings destination.

Slot entry `order` cannot express the desired arrangement. It sorts entries within the list-valued `sidebar.footer.action` slot but cannot move an entry across the separate `sidebar.filetree` and `sidebar.settings` slots.

## Proposal

The expanded sidebar will render its lower destinations in this order: registered footer actions, the workspace file tree, then Settings. The file tree remains the single occupant of `sidebar.filetree`; footer actions remain additive entries in `sidebar.footer.action`; Settings remains the single occupant of `sidebar.settings`.

The sidebar shell will own this ordering. It will keep the file tree wide-only, bounded to at most 40% of the column height, internally scrollable, and absent without a file-tree occupant. The collapsed rail will continue to omit the file tree and render footer actions above Settings.

The change will update the sidebar shell component and styles, its focused component coverage, the assembled keyless Web snapshot that shows the destination order, and the sidebar package documentation in both languages.

## Alternatives considered

**Use slot entry `order`.** The three destinations belong to different slots, so a numeric order on the file-tree registration cannot participate in footer-action ordering without changing the slot system's meaning.

**Register the file tree as a footer action.** This would give the panel the wrong owner props and rail behavior, mix a bounded browsing panel into a row-oriented action list, and discard the dedicated file-tree slot.

**Override the deployed CSS or DOM.** A server-only override would diverge from the packaged client, lack repository tests, and disappear on the next installer update.

## Acceptance criteria

- In the expanded sidebar, every `sidebar.footer.action` row renders above the file-tree panel, and the Settings row renders below it.
- Footer-action `order` continues to determine only the relative order of footer actions.
- The file tree remains wide-only, collapsible, internally scrollable, capped at 40% of the sidebar height, and gap-free when no occupant renders.
- The collapsed rail keeps footer actions above Settings and does not render a file-tree control.
- Focused sidebar tests and a keyless assembled Web snapshot pin the visible order.
- The English and Chinese sidebar package documentation describes the resulting placement.

## Risks

Several footer actions reduce the vertical space available above the fixed Settings row. The layout must preserve the file tree's usable bounded height without allowing footer actions or the panel to push Settings outside the column.

The proposal makes one product-wide ordering decision for all deployments. A future requirement for deployment-specific cross-slot ordering would need a separate typed layout extension rather than numeric orders that silently cross slot ownership.
