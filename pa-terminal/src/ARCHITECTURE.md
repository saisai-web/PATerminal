# Frontend architecture

The frontend is a feature-oriented modular monolith. It keeps one browser bundle and one shared
runtime, while placing code by the capability that owns it instead of accumulating modules in the
`src/` root.

## Source map

```text
src/
├── main.ts                 composition root: initialize features and connect dependencies
├── app/                    application lifecycle and cross-feature coordinators
├── terminal/               xterm/PTY panes, trees, focus, and layout
├── workspace/              workspace model, groups, and shared runtime state
├── features/
│   ├── agents/             running-agent detection, session resume info, and the resume banner
│   ├── attachments/        native image picker and terminal path insertion
│   ├── broadcast/          broadcast target picker for the toolbar toggle
│   ├── explorer/           filesystem explorer, import, and file viewer
│   ├── git/                change strip, Git actions, PRs, Issues, and worktrees
│   ├── history/            shared dialog for conversation and deleted-session history
│   ├── license/            trial/license status, soft-lock gate, lock marks, purchase modal, banners
│   ├── pair/               pair mode: implementer/reviewer panes handing work to each other
│   ├── quick-phrases/      reusable command phrases
│   ├── settings/           settings UI and themes
│   ├── sidebar/            workspace navigation, selection, recently deleted sessions, menus, and Git badges
│   └── update/             signed official updater bridge, progress, install, and restart flow
├── shared/                 cross-cutting helpers and shared values
├── platform/               environment-specific adapters such as the browser test mock
├── i18n/                   translation dictionaries and locale selection
└── styles/                 cascade-ordered CSS modules
```

## Placement rules

1. Keep `main.ts` as the composition root. It may initialize features and pass callbacks, but it
   must not grow feature behavior.
2. Put a user-facing workflow under `features/<capability>/`. Keep its rendering, state, and helper
   modules together when they change for the same reason.
3. Put terminal runtime behavior in `terminal/` and workspace data/state in `workspace/`.
4. Put application startup, persistence, global shortcuts, and other cross-feature coordination in
   `app/`.
5. Use `shared/` only for code used by multiple capabilities that does not belong to one of them.
   Environment-specific substitutes belong in `platform/`.
6. Use explicit relative imports. Avoid barrel files while the existing modules still contain
   circular runtime relationships; barrels can change ESM initialization order.
7. Do not add another top-level TypeScript module beside `main.ts`. The architecture check in CI
   enforces this boundary.

Cross-capability imports are currently allowed because the application predates this directory
layout and several UI flows are intentionally coordinated. When changing those flows, prefer
passing a callback from `main.ts` or `app/` over adding a new cycle.

The CSS tree remains separate because `styles.css` defines a deliberate import order. Moving style
files alongside features would change the cascade unless the aggregator order were preserved.

## Verification

Run these checks after moving modules or changing boundaries:

```sh
npm run check:architecture
npx tsc --noEmit
npm run dev &
node ui-test.mjs
```
