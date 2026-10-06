---
name: fix
description: Fix UI feedback that the Pickfix browser extension queued for this repository. Use when the user mentions Pickfix feedback, queued UI feedback or a batch id to handle. Do not use for bug reports or UI changes the user describes directly.
---

Work through the Pickfix feedback queue for this repository.

1. Call `pickfix_list_batches`. If "$ARGUMENTS" names a batch id, use that batch; otherwise take the oldest queued batch. If none are queued, say so and stop.
2. Call `pickfix_claim_batch` so no other session works on the same batch. Read every item and look at every screenshot and reference image before editing: screenshots show the current state, reference images show the look the reviewer wants.
3. For each item, locate the code in this order:
   a. `source.file:line` when confidence is `exact` or `file`;
   b. the component chain: search for the component's definition;
   c. the route: map it to the page or route file of the framework in use;
   d. distinctive text, test ids or class names from the captured element.
   If the location is still ambiguous, choose the most likely match and state the assumption in your report rather than guessing silently.
4. Make the smallest change that satisfies the reviewer's request. Follow the project's existing conventions (styling system, design tokens, component library).
   For `text-edit` items, change the copy to exactly the requested "after" text, including any i18n resource files that hold it.
   For `flow` items, walk through the steps, find the failing step, and fix the cause rather than the symptom.
   For `region` items, the reviewer boxed an area of the page: change the layout or spacing of the elements in it together, not just one element. Its elements are listed under "Where in the code".
   An item with no written request means: make the target match its reference image(s).
5. If the project has fast checks (type-check, lint, the relevant unit tests), run them.
6. Call `pickfix_report` with outcome `done`, `partial` or `failed`; a one- or two-sentence summary written for the reviewer (what changed and where, or why not); `changedFiles`; and a per-item outcome with a short note.
7. If more batches are queued, continue with the next one.
