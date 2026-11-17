# Agent Deck design

## Control surface

Keep the graphite enclosure, inset square keys, restrained mint selection and
amber blocked state. This is an operating console, not an analytics dashboard.
The Agent Deck wordmark and original neutral letter badges are not vendor logos.

All 15 authored positions belong to the user. A sessions entry opens a separate
generated bank: 12 sessions and whole-key Return/Previous/Next. Never reserve,
relocate or overwrite authored coordinates for generated navigation. Missing
entry/return paths block publication with a precise diagnostic.

Remote landscape uses five columns and three rows; portrait uses three columns
and five rows. Keys remain square. Preserve safe-area insets, scrolling at narrow
or short widths, readable two-line labels and touch targets. Hover is pointer-only;
keyboard focus remains visible; reduced-motion disables press animations.

## PC authoring

Only an actual localhost peer can use the page list / preview / key-settings
workspace. Key selection while editing changes assignment, never sends input.
The assignment inspector is inline, not modal; pairing, reset and destructive
dialogs remain protected. Escape returns focus to the selected key. Save, conflict
and storage-failure states must remain explicit and preserve the frozen draft.

Remote controllers must not gain management authority from viewport size,
forged proxy headers or opening the editor programmatically.

## State and action truth

Show observed idle/working/blocked/done/unknown states distinctly. Offline locks
input and must not imply that stale terminal text is a current approval request.
Blocked, unknown and offline cues outrank custom colors and images. Demo data
must remain labeled and cannot dispatch effects.

Response keys send directly without a per-key confirmation popup; the server
still checks the current ticket, original request text and exact target. Editing,
demo, Reason read-only mode and stale/offline targets cannot send approvals.
Custom actions use their own snapshot/revision/nonce and receiver proof, not the
built-in approval route. No automatic retries, replay or focus-based retargeting.

## Maintained sources

`src/deck/streamdeck-feel.css` owns console geometry and shared badge sizing.
`scripts/build/apply-mk2.mjs` embeds maintained source into the canonical HTML via
`npm run build`. The transformation must be idempotent; historical backups are
never build inputs. See README for domain boundaries and test prerequisites.

Chromium geometry and synthetic fixture screenshots are regression evidence,
not physical iPad Safari, Windows GUI or complete accessibility certification.
