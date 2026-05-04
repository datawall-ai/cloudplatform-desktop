# Workplace Training / Workflow Observability — Status

End-to-end feature: desktop Electron shell records the user's screen during
a workflow run, sessions are tagged with `{ workflowId, runId, workspaceId }`,
and the recordings get pushed to the UAC API for compliance + training review.

Three repos involved (all under `/Volumes/T7/Developers/`):
- `cloudplatform-desktop/` — Electron shell + IPC bridge + (future) recorder
- `cloudplatform/` — web app, hosts the in-Workflow observability UI
- `uac/` — backend API that accepts session metadata + chunks

---

## Done

### `cloudplatform-desktop/` (Electron shell)
- `electron/preload.cjs` — exposes `window.electronAPI.workplaceTraining`
  with `{ version: 1, listSources, startSession, stopSession, getStatus,
  onEvent }`. Versioned so the web app can gate features per-build.
- `electron/main.cjs` — wires `workplaceTraining.init()` into
  `app.whenReady()` before `createWindow()` so the renderer never sees a
  missing-handler error on a fast page boot.
- `electron/workplaceTraining.cjs` (new, ~214 lines) — IPC handlers
  (`wt:list-sources`, `wt:start`, `wt:stop`, `wt:status`,
  `wt:append-chunk`, `wt:bridge-version`), in-memory session table, on-disk
  manifest at `userData/workplace-training/<sessionId>/manifest.json`, and
  a tray indicator with one-click stop. **Recorder itself is stubbed** —
  sessions transition `starting → recording → stopping → stopped`
  synchronously; no `BrowserWindow`/`getUserMedia`/`MediaRecorder` yet
  (TODO markers in the file at the slice-3 entry points).
- `electron/entitlements.mac.plist` — comment-only update explaining no
  audio/camera entitlements are needed (TCC + `NSScreenCaptureUsageDescription`
  cover screen recording).

### `cloudplatform/` (web app)
- Removed the standalone "Workplace Training" nav item, page export, and
  `WorkplaceTrainingPage.jsx` file. Observability is **not** a top-level
  nav anymore — it lives inside the Workflow tab per the design intent.
- Added `WorkflowObservabilityPanel` inside
  `src/components/dashboard/pages/WorkflowsPage.jsx`. Desktop-only (renders
  `null` in a regular browser tab via `useDesktopBridge` +
  `caps.workplaceTraining >= 1`). Source picker, start/stop, active
  recording indicator with pulsing dot, error surface. Every session is
  tagged with `{ workflowId, workflowName, runId, workspaceId,
  startedFrom: 'WorkflowRunner' }` in `sessionMeta`.
- `src/hooks/useDesktopBridge.js` — versioned bridge detection
  (`caps.workplaceTraining`).
- `src/components/dashboard/pages/Pages.css` — renamed the standalone-page
  styles (`.wt-*`) to in-card panel styles (`.wf-observability-*`).
- `src/components/dashboard/Dashboard.jsx` — removed the
  `workplace-training` nav entry, page-title entry, `desktopOnly` filter
  branch, and the `case 'workplace-training'` in `renderPage()`.

### `uac/` (backend API)
- New `src/api/routes/observability.py` — stub router with:
  - `POST   /uac/observability/sessions`             register a session
  - `PATCH  /uac/observability/sessions/{id}`        update status / counters
  - `POST   /uac/observability/sessions/{id}/chunks` upload a chunk (multipart)
  - `GET    /uac/observability/sessions`             list (filter by workflow_id / run_id)
  - `GET    /uac/observability/sessions/{id}`        fetch one
- Workspace-scoped via the existing `WorkspaceIdDep`, JWT-required via
  `CurrentUserDep`. In-memory store (process-local). Chunk handler counts
  bytes but does **not** persist payload — `TODO` for object storage.
- Registered in `src/main.py` alongside the other `/uac` routers.

---

## Next up (in order)

1. **Wire the upload from the desktop client to the UAC API.**
   Two paths — pick one before coding:
   - **(a) Renderer-driven** *(recommended, smaller)* — the cloudplatform
     web app already has the JWT in memory. Have `WorkflowObservabilityPanel`
     call `POST /uac/observability/sessions` on start and `PATCH .../{id}`
     on stop. The bridge stays storage-only; chunks go to the API later
     when the real recorder lands. Limitation: uploads stop if the renderer
     window is closed mid-recording.
   - **(b) Main-process-driven** — add an IPC handshake from renderer to
     main that hands over `{ apiBase, jwt }` at startup so
     `workplaceTraining.cjs` can post directly. Survives the renderer
     window being closed. More plumbing, plus a token-refresh story.

2. **Implement the actual recorder (slice 3 in `workplaceTraining.cjs`).**
   Spawn a hidden `BrowserWindow`, run `getUserMedia` with the chromium
   `desktopCapturer` constraint, drive `MediaRecorder` at ~5s chunks, pipe
   blob bytes back to main over `wt:append-chunk`, write to
   `userData/workplace-training/<sessionId>/chunk-NNNNNN.webm`. Replace the
   synchronous status transitions in `wt:start`/`wt:stop` with real
   lifecycle awaits.

3. **Chunk uploader.** Background drain of the per-session chunk dir to
   `POST /uac/observability/sessions/{id}/chunks` with retries +
   exponential backoff. On successful upload, delete the local chunk.
   On final stop, mark the session `stopped` once all chunks are flushed.

4. **Persist sessions in UAC.** Replace the in-memory `_SESSIONS` dict in
   `src/api/routes/observability.py` with a Postgres table
   (`observability_sessions`) and chunks with object storage (S3/GCS at
   `observability/{workspace_id}/{session_id}/chunk-{idx:06}.webm`).
   The view-model already matches what a real schema would look like —
   the swap should be local to that file.

5. **Surface recordings back in the UI.** Add a "Recordings" sub-section
   in the workflow run history (`RunDetail` in `WorkflowsPage.jsx`)
   that calls `GET /uac/observability/sessions?workflow_id=...&run_id=...`
   and lets reviewers play back. Player UI is desktop-or-browser
   (recordings are accessible from any context, only *recording* is
   desktop-only).

6. **Auto-bind recording to a real `runId` after submit.** Today the
   panel passes `runId={null}` because `WorkflowRunner` calls
   `onExecuted()` and navigates away on submit. After (1) is wired, change
   the runner to either (a) keep the panel mounted post-submit until the
   recording stops, or (b) emit a `PATCH .../{sessionId} {run_id}` once
   the run is created so the binding is established without keeping the UI
   open.

7. **Consent + admin policy.** Director-level consent is on file at the
   contract layer per the file header in `workplaceTraining.cjs`, but we
   should still:
   - Add a per-workspace toggle (`observability_enabled`) so admins can
     turn it off.
   - Show a one-time "this workspace records workflow runs" disclosure
     the first time a user opens a workflow with observability enabled.

8. **Update the bridge version.** Once the real recorder lands or the
   contract changes in a non-additive way, bump
   `BRIDGE_VERSION` in `electron/workplaceTraining.cjs` and the matching
   `version: N` in `electron/preload.cjs`. Update
   `OBSERVABILITY_REQUIRED_BRIDGE` in `WorkflowsPage.jsx` accordingly.

---

## Open questions for the morning

- (1a) vs (1b) above — renderer-driven uploads, or token handshake to main?
- Is it OK that closing the desktop window kills an in-progress recording
  if we go with (1a)?
- Format: are we sticking with WebM/VP9 from `MediaRecorder`, or do we want
  to transcode to MP4 server-side for compatibility with downstream tools?
- Retention: how long do we keep recordings, and who can delete them?

---

## Additional book of work (deferred)

These were planned alongside the form-less "Watch and flag" workflow type
but are scoped out of the current cut so we can ship the desktop-side
piece first. Each is a meaningful unit of work and can land independently
once the foundation below is in place.

### Phase A — Findings pipeline (the watch-rule execution loop)

- New table `observation_findings`:
  `(id, workspace_id, workflow_id, session_id, detected_at, severity,
    summary, evidence, acked_at, acked_by, deleted_at)`
- New Celery task `evaluate_watch_rules_for_session(session_id)` —
  fires from `stitch_and_dispatch_observability_session` once stitching
  finishes. For each active observation workflow whose audience covers
  the recorded user, runs an agent over the stitched transcript +
  window manifest. Inserts 0..N findings.
- Cost-aware execution model — **arm a watcher pattern, not a poll**:
  - Each watch rule produces a "trigger condition" (small prompt) and a
    "review prompt" (large prompt).
  - The trigger condition is evaluated cheaply on the manifest's
    window_series — looking for the apps/keywords that would matter for
    this rule. If the trigger fires (or a max wall-clock window elapses,
    e.g. 24h), only then run the full LLM review on the relevant slice
    of the recording.
  - Re-arm the watcher after each evaluation so coverage continues.
  - Default model: turbo (we own it; cost per call is acceptable).
- Notification emission per finding to the workflow's audience (existing
  notifications system, new `observation_finding` type).
- Workflow detail UI — new "Findings" tab visible only when
  `purpose='observation'`, listing findings reverse-chronologically
  with ack/dismiss.
- LLM-determined severity + dedupe so noisy rules self-throttle.

### Phase B — Conversations ↔ workflows

- Chat tools registered in UAC's chat router:
  - `list_workflows({ purpose?, audience_scope? })`
  - `get_workflow(workflow_id)`
  - `recent_runs(workflow_id, limit)` (form-based workflows)
  - `recent_findings(workflow_id?, since?, severity?)`
  - `summarize_workflow_activity(workflow_id, window)`
- Tools call existing API endpoints with the user's JWT — workspace +
  audience scoping is already enforced server-side, so no new RLS work.
- Optional polish (own follow-up): when chat references a workflow or
  finding, render a clickable card that deep-links into the Workflows
  tab.
- "Easy questions" surfacing — quick-suggest prompts on the Workflows
  tab itself (e.g. "What's flagged today?") that feed straight into the
  chat surface so users don't have to think up the prompt.

### Privacy / capture scope (carried over)

These are not blockers given the enterprise posture, but worth doing
when convenient:

- Workspace-level `excluded_apps: string[]` on
  `workspace_observability_settings`. Apps in this list have their
  window-metadata entries stripped before the manifest leaves the
  desktop. UI: editable list in the Observability section of
  Organization page.
- "Pause recording when excluded app is foreground" — different and
  stricter than metadata redaction. Stops the MediaRecorder while a
  blacklisted app is focused, resumes when it loses focus. Adds a small
  pause/resume control plane to the recorder.
- Per-rule `scope` field on observation workflows — text the watch
  agent gets prepended to its instruction (e.g. "only consider
  activity in Chrome and Excel"). Stored in
  `workflows.metadata.observation_scope`. Soft filter (LLM honors)
  rather than hard filter (server enforces) until accuracy demands the
  upgrade.

---

## Notes

- `cloudplatform-desktop` `main` is in sync with `origin/main` (verified
  via `git rev-list --left-right --count main...origin/main` → `0 0`).
  The session-start git snapshot showed "behind by 1" but that was already
  resolved by the time these changes landed — no pull needed.
- All cloudplatform-desktop changes are uncommitted in the working tree:
  `M electron/{entitlements.mac.plist, main.cjs, preload.cjs}`,
  `?? electron/workplaceTraining.cjs`, `?? todo.md`.
- cloudplatform (`dev` branch) uncommitted set after this session:
  `M src/components/dashboard/pages/{Pages.css, WorkflowsPage.jsx}`,
  `?? src/hooks/useDesktopBridge.js`. Note: `Dashboard.jsx` and
  `pages/index.js` were also touched, but the edits *reverted* the
  prior-session additions (the nav item + page export), so those files
  are back to their committed state and won't appear in `git status`.
  `WorkplaceTrainingPage.jsx` was deleted (was untracked, so it's just
  gone from the working tree — no `git rm` needed).
- uac (`main` branch) uncommitted set: `M src/main.py`,
  `?? src/api/routes/observability.py` (this feature), plus pre-existing
  unrelated edits from earlier work — `M run.sh`, `M src/api/routes/kb.py`,
  `M src/api/routes/workflows.py`, `M src/services/kb_client.py`.
