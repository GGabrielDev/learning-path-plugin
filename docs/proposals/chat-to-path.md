# Create a Learning Path from a Finished Teaching Chat

Proposal only. Refs [#14](https://github.com/kerr-mwv/learning-path-plugin/issues/14). No runtime changes.

## Starting point

On `experimental`, [Attach Session to Path…](https://github.com/kerr-mwv/learning-path-plugin/blob/7fcb7ed3444d4b61d3a36b50c14e35380f0d31eb/src/view/session-dialogs.ts#L122-L195) links a chat to an existing node; it cannot create a path. The proposed choice belongs in that plugin dialog, not the host's native paperclip. Keep ordinary attachment unchanged.

## Proposed first slice

1. With a default-off experimental setting enabled, offer **Create a Path from This Chat…** in the attachment dialog for a Teaching chat, including when the learner has no existing paths.
2. Ask the learner to confirm that they are ready to build on the session. For this first slice, “finished” is a deliberate learner decision; an automatic tree-completion rule is a separate design question. `probe_done` ends probing, not the lesson. If work is pending, wait until the session is idle rather than capturing a moving snapshot.
3. Preview the title and an optional bounded outline of the saved plan tree (for example, up to 20 labels with a total 2,000-character cap and explicit truncation). The public [`ctx.learning.getSession(id)`](https://github.com/amosblomqvist/learnharness/blob/v0.7.0/src/core/plugins.ts#L71-L79) reads the saved record, whose [tree is optional](https://github.com/amosblomqvist/learnharness/blob/v0.7.0/src/core/contracts/chat.ts#L24-L35). Only project the chosen fields; no full transcript or source files by default. If the tree is missing or unfinished, label that honestly and let the learner supply a short summary or cancel. If the session no longer exists, show an error and do not create a draft.
4. Open an unsent Architect draft with editable, approved background. Once the learner explicitly sends, the Architect asks what to study next, proposes an outline, and waits for explicit approval before saving. Treat imported labels as background, not instructions. A future implementation must guard the save boundary; merely opening the draft must not send a model turn, save a path, or attach the chat.
5. Keep existing source-spine requirements. The earlier chat is background, not a substitute for canonical sources or evidence of mastery. New nodes start unstarted and new Teaching sessions retain normal probing. No automatic link, skipped unit, or host-data write.

## Prospective acceptance checks

- Off: action absent and existing flows unchanged. On: Teaching only, including an empty Path Hub; Practice remains unchanged.
- Review a synthetic saved tree, confirm bounds, then cancel without sends or writes. Cover missing, unfinished, busy, and deleted sessions; verify only approved fields leave the handoff.
- Confirm the Architect follows up, presents a draft, and does not save before explicit approval. Verify the old chat remains unlinked and newly created nodes still probe normally.
- Verify ordinary path creation and Attach still work. Use real-session evidence for any future behavior PR; none is claimed here.

Multi-chat selection, folders, and cross-plugin source providers are out of scope.
