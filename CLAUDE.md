# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"What would Joe Rogan say?" (whatwouldjoerogansay.com): users search a topic, get semantically matched JRE podcast segments shown as embedded YouTube players with clickable timestamps; signed-in users (free, 5/day quota — the Stripe paywall was removed in Oct 2026) can generate a downloadable compilation video of selected segments.

**Current state / pending work:** see the newest entry at the top of `docs/status.md` (handoff notes, deploy order, open decisions). As of 2026-10-23 the redesigned clipper (renderer `v2`), search proxy and paywall removal are **live**, and the legacy stack (Stripe functions, `streamJobStatus`, `getVertexAiToken`, the Python/C# processors, Pub/Sub triggers, all user-managed SA keys) has been deleted.

The repo is several independently deployed parts with no shared build. All live infrastructure is in GCP project `gen-lang-client-demo` (number `408323719521`). Firestore uses the **named database `jre-clipper-db`**, not `(default)`. Every client must pass it explicitly.

**Deployed code may differ from your working tree.** Before reasoning about production behavior, check the deployed source:
- Cloud Run source zips: `gs://run-sources-gen-lang-client-demo-us-central1/services/<name>/`
- Firebase Functions source: `gs://gcf-v2-sources-408323719521-us-central1/<fn>/function-source.zip`
- Hosting: fetch the files from the live site.

GitHub `origin/master` matches production as of 2026-10-25 (the `clipper-redesign` branch was merged in PR #1).

## Project rules (from `.github/instructions/projectrules.instructions.md`)

- Read the docs in `docs/` before implementing: `requirements.md` is the source of truth for requirements, `flow.md` covers system/user flows, `backend.md` is the backend guide, and `status.md` tracks progress.
- After completing a step, update `docs/status.md`. New entries go at the top, dated.
- Ask for clarification when requirements are unclear.

Caveat on the docs: the architecture has pivoted several times. The newest `status.md` entries reflect reality, but the "Architecture Overview" section further down `status.md` is stale. The first half of `backend.md` (Qdrant, a .NET search API) and all of `backend-outdated.md` describe abandoned designs. `flow.md` describes the original request-ID/download design.

## Components

### 1. `frontend-firebase/`: Firebase Hosting site + Firebase Functions

- `public/` is vanilla JS/HTML with PicoCSS and the Firebase **compat** SDK (v11.9.1), loaded from the reserved `/__/firebase/...` URLs. Pages only work when served by Firebase Hosting or the emulator. No build step; JS/CSS URLs carry a `?v=` cache-buster (the site is behind Cloudflare).
- **All backend calls are Firebase callables** in `functions/index.js` (Functions v2, Node 22, ESM, one file). The browser never receives a Google access token.
  - `searchSegments` / `answerQuery`: server-side proxy to Vertex AI Search (Discovery Engine) `:search` / `:answer`. They run as SA `jre-search-reader@` (only `roles/discoveryengine.user`), with an in-memory 10-minute LRU cache.
    - Engine: `jreclipper_1750261043616`, location `us`, Enterprise + LLM add-on.
    - Data store: `jre-transcriptions_1750261216656`.
    - Documents look like `structData.{content, structData{videoId,startTime,endTime,videoTitle,channelName}}` (note the nesting).
  - `createVideoJob` (sign-in required): validates segments (max 30 segments, 10 min each, 20 min total) and enforces 5 jobs per user per UTC day in a transaction on `usageDaily/{uid}_{day}` (admin = `ADMIN_EMAIL` is exempt). It applies a global cap of 3 active jobs, resolves source objects in `gs://jre-all-episodes`, writes `videoJobs/{uuid}`, and starts the Cloud Run Job `jre-clip-renderer` with env override `JOB_ID`.
  - `listMyVideos` (the `videos.html` "My videos" page) and `getVideoJob` run as SA `jre-clip-reader@`: `datastore.viewer`, read on `edited-clips/` only, and signBlob as itself. They sign a fresh 12 h URL per request. Finished videos are kept forever: the 8-day lifecycle rule was removed on 2026-10-27, and older clips are gone. The renderer's stored 7-day `finalVideoUrl` isn't served anymore.
  - `getVideoJob`: returns only the caller's own job; `status.html` polls it with backoff. The compat SDK can't open the named Firestore DB, so there is no realtime listener, and Firestore rules deny all client access.
  - Also `getVideoMetadata` (YouTube Data API, 1-hour cache), `getUserUsageStats`, `recordSearchActivity`.
- Config: `functions/.env` (gitignored, must exist locally before `firebase deploy`) holds `YOUTUBE_API_KEY` and `ADMIN_EMAIL`.
- Firestore collections:
  - `jre-episodes` is the **ingestion tracker**: one doc per videoId with `title`, `date`, `Url`, `isTranscripted`, `isVectorized`, `isEmptyTranscript`.
  - `videoJobs` holds clip jobs.
  - `usageDaily` holds the quota counters.
  - Legacy, unused: `subscriptions`, `manualVideoRequests`, `emailNotifications`.

### 2. `video-processor-CloudRun-Function/JreClipRenderer/`: clip renderer (Cloud Run **Job**, .NET 10)

A console app that renders one `videoJobs/{JOB_ID}` document and exits.
- Runs as SA `jre-clip-renderer@`, which can read `jre-all-episodes`, read/write objects in `jre-processed-clips-bucker`, use `datastore.user`, and sign URLs as itself.
- Sources come from a read-only GCS FUSE mount of `jre-all-episodes` at `/jre-videos`. Most are `{id}.mp4`, a few legacy `{id}_JRE…mp4`, all 854x480 AV1/VP9 + Opus with moov at the front.
- Rendering:
  1. Probe each distinct source once.
  2. Encode every segment in the user's order, in parallel (2 at a time): frame-accurate input seek, 854x480 29.97 fps H.264 cut to an exact frame count (`trim`, not `-frames:v`, which truncates audio), plus **PCM** audio padded/trimmed to exactly that many samples (n × 1601.6), 30 ms fades, in `.mov`.
  3. Join with the ffmpeg **concat demuxer** (explicit per-file `duration`), copying the video and encoding AAC once (`-aac_coder fast`), plus faststart.
  4. Validate the duration.
  5. Upload to `edited-clips/{jobId}/final_video.mp4` and sign a 7-day V4 URL via IAM `signBlob` (`IamBlobSigner`).
- An atomic Firestore claim makes duplicate executions no-ops; a retry of the same execution may resume.
  - `searchSegments` returns a ~30-word transcript excerpt per hit, never the full chunk. `answerQuery` is a neutral, cited summary (the "AI Joe Rogan" persona and custom instructions were removed on 2026-10-31) and returns `sourceIds` that match the search result ids.
  - Product analytics: `public/analytics.js` (persistent visitor id in localStorage, no cookies) → `trackEvents` → `analyticsEvents`. Own traffic is tagged `internal` (admin account, or any page opened once with `?internal=1`). Read the funnel with `python frontend-firebase/tools/analytics_report.py --days 30`. Log docs carry `expireAt` (24-month TTL, promised in `privacy.html`).
  - Legal pages: `terms.html`, `privacy.html`, `copyright.html` (operator VU Solutions LLC, Vietnam). Keep them true when changing what is collected or stored.
- Exit 0 means done, permanent failure, or nothing to do; exit 1 means retryable (the job has `--max-retries=1`).
- Progress writes are throttled to one per 2 s, and the progress writer is stopped before the final status write.
- Local testing without the cloud: `JOB_FILE=job.json SOURCE_ROOT=F:/jre-all-episodes OUTPUT_DIR=out dotnet run -c Release`. Against real Firestore/GCS, run the container with `GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)` and `SIGNER_EMAIL=jre-clip-renderer@…`.
- Deploy with `./deploy.sh` (Docker build, push to `cloud-run-source-deploy/jre-clip-renderer`, `gcloud run jobs deploy`). Without Docker Desktop: `gcloud builds submit --region us-central1 --tag <image>:<tag> .` (with a `.gcloudignore` excluding `bin/` and `obj/`), then the same `gcloud run jobs deploy` flags as `deploy.sh` with the new digest.
- **A/V sync is the thing to protect.** Joining separately encoded AAC segments drifts at every seam (the old pipeline and renderer `v1` had audio ~270 ms early after 30 segments). After any change to segment encoding or concat, run `tools/av_sync_check.py` on a local multi-segment render; healthy is about -1 ms on every segment.
- Measured on a 5-segment, 4-minute job: 10 s natively, versus 64 s for the old pipeline, with output 36% smaller. A 30-segment, 16-minute job renders in ~75 s on Cloud Run, plus a ~40 s cold start.

### 3. `JREClipper.sln`: offline ingestion pipeline that builds the search index (.NET 8)

`Api` → `Infrastructure` → `Core` (interfaces in `Core/Interfaces`). This is **not deployed**. You run it locally and drive it through Swagger. It produced the search data store's documents (last run June 2025; newest indexed episode is #2337):

1. Root Python scripts:
   - `jre-playlist-ingestion.py`: YouTube API → playlist CSV.
   - `fetch-transcriptions-apify.py`: Apify actor `fWIyRKfnKlxB1r5CX` → `transcriptions/transcript-{videoId}.json`. The shape is a list containing one object with `videoTitle`, `channelName`, `url`, `transcript`, and `transcriptWithTimestamps[{timestamp:"m:ss", text}]`. The canonical copies are in `gs://jre-content/transcriptions/`.
2. `GET /api/Ingestion/get-utterances-from-transcript` uploads utterance JSONL to `gs://jre-processed-clips-bucker/utterances-for-embedding/`.
3. A Vertex AI batch prediction job embeds the utterances (`batch-embedding-request.json`, `text-embedding-005`, `RETRIEVAL_DOCUMENT`). Results land in `utterance-embedding-results/` and were copied locally to `utterence-embedding-results-{1..4}/` (sic).
4. `POST /api/Ingestion/create-indexed-embeddings` regroups the results into `indexed-embeddings/{videoId}.jsonl`.
5. `POST /api/Ingestion/run-semantic-chunking` calls `IntelligentTranscriptProcessor.ChunkTranscriptFromPrecomputedEmbeddings`. Embeddings are used **only to choose segment boundaries**; Vertex AI Search does its own indexing. It writes `gs://jre-processed-clips-bucker/final-semantic-chunks/jre-segments-all.ndjson`, which was imported into the data store.
6. The `jre-episodes` flags in Firestore are updated separately (`upload_csv_to_firestore.py`).

Ingestion endpoints use **hard-coded paths relative to the working directory** (`../transcriptions`, `../indexed-embeddings`, ...). Run from `JREClipper.Api/`. `SearchController` and the Vertex AI Vector Search / Qdrant config in `appsettings.json` (project `jre-clipper-project`) are leftovers from an earlier design, not the live search path.

### 4. Root utility scripts

- `check_missing_videos.sh` and `advanced_object_rename.sh` maintain `gs://jre-all-episodes` (2,100+ MP4s, ~730 GB).
- `clean_csv.py`, `extract_filtered_urls.py`, and `check-corrupted-transcripts.py` work on the playlist CSV and `transcriptions/`.

### 5. `ingestion/`: free incremental ingestion of new episodes (Python, home PC)

Replaces the Apify/Vertex steps of section 3 for new episodes. Run from the repo root: `ingestion\.venv\Scripts\python -m ingestion <step>`. Data, `state.json` and `ingestion.log` live in `F:\jre-all-episodes\ingestion\` (override with `JRE_DATA_ROOT`).
- Steps: `discover` (playlist + channel uploads via yt-dlp, diffed against `jre-episodes`), `captions` (YouTube captions as json3 → `transcriptions\transcript-{id}.json`, lines grouped into ~5 s entries like the old Apify files), `chunk` (fastembed `bge-small-en-v1.5` on CPU + an exact port of the C# chunker), `import` and `mark` (both dry-run unless `--apply`), `download` (480p → `gs://jre-all-episodes`, verify, delete local), `calibrate`, `status`.
- Backfill episodes (empty 2025 transcripts) sort first, so pass `--new-only` to work on new episodes only. Long runs go through `ingestion/run_bulk.ps1 text|download|backfill|backfill-download|new`, launched detached with `Start-Process` (see the script header), because background shells die with the session.
- Task Scheduler task "JRE ingestion new episodes" (`ingestion/register_task.ps1`) runs `run_bulk.ps1 new` daily at 06:00: discover → captions → Whisper fallback → chunk → download. Import and mark stay manual.
- `download` runs yt-dlp in a child process and kills it after `DOWNLOAD_STALL_SECONDS` without progress; `.part` files let the next pass resume.
- The search page greys out episodes with no MP4 in `gs://jre-all-episodes` ("Video not available yet"): `getVideoMetadata` returns `available` from a cached bucket listing.
- The corpus was actually built with a 30 s minimum chunk, not the 20/5 in `appsettings.json` or the 60/10 C# fallback. The 0.82 threshold almost never fired. The local model uses 0.80, calibrated to the same no-break rate.
- The data store import used GCS `dataSchema: custom` + `autoGenerateIds`. Document id = `sha256(ndjson line)[:32]`.
- Needs Deno on PATH (yt-dlp's YouTube JS challenges) and a gcloud CLI login (ADC is not used).

## Commands

There are no tests or linters in this repo.

```bash
# .NET ingestion solution
dotnet build JREClipper.sln
cd JREClipper.Api && dotnet run          # Swagger UI at http://localhost:5208/swagger
# GCP calls use Application Default Credentials: gcloud auth application-default login

# Firebase (project alias "default" = gen-lang-client-demo); firebase CLI: npm i -g firebase-tools
cd frontend-firebase/functions && npm install
npm run serve                            # functions emulator (from frontend-firebase/functions)
firebase deploy --only hosting           # from frontend-firebase/
firebase deploy --only functions

# Clip renderer (Cloud Run Job): build, push, deploy (Git Bash on Windows)
cd video-processor-CloudRun-Function/JreClipRenderer && ./deploy.sh
dotnet build -c Release                  # from JreClipRenderer/
```

**CI/CD:** a push to `master` deploys automatically through `.github/workflows/deploy-{hosting,functions,renderer}.yml`. Each workflow runs only when its own paths change and can also be started by hand. Auth is keyless Workload Identity Federation, limited to this repo on `refs/heads/master`, impersonating the deploy-only SA `github-deployer@`. The roles and pool are set up by `.github/setup-gcp-deployer.sh` (idempotent). If a deploy fails on a missing permission, add the role there and re-run it. The deployer deliberately can't set IAM on Cloud Run services. So the first CI deploy of a **new** function fails with "Unable to set the invoker". Run `gcloud run services add-iam-policy-binding <lowercase-name> --region=us-central1 --member=allUsers --role=roles/run.invoker` once (every callable is public and checks auth itself), then re-run the workflow. Functions get `YOUTUBE_API_KEY` / `ADMIN_EMAIL` from repo secrets. The manual commands below still work for local deploys.

`firebase deploy` needs `firebase login`; ADC is not configured on the Windows machine. firebase-tools isn't installed globally; `npx -y firebase-tools@14` works with the stored login. In Git Bash, `MSYS_NO_PATHCONV=1` breaks the `gcloud` launcher. Use `MSYS2_ARG_CONV_EXCL` for the single flag that carries a POSIX path, as `deploy.sh` does.

## Repo gotchas

- `JREClipper.*/obj/` files are tracked in git despite `.gitignore`, so any restore or build shows them as modified. Leave them out of commits unless asked.
- Large data dirs and CSVs (`transcriptions/`, `utterence-embedding-results-*`, `indexed-embeddings/`, `jre-playlist*.csv`) are gitignored and live only on a developer machine or in GCS.
- Discovery Engine IDs and the renderer job URL are hard-coded in `frontend-firebase/functions/index.js`.
- Artifact Registry repo `gcf-artifacts` is auto-cleaned, so existing Firebase function revisions can't be redeployed with `gcloud run services update`; redeploy from source instead.
- Hosting serves HTML with `Cache-Control: no-cache` (`firebase.json`) so a deploy reaches returning visitors immediately; JS/CSS rely on the `?v=` bump instead.
- Security history: until 2026-10-22 the public `getVertexAiToken` handed anonymous callers a token for the Editor-role compute SA; it was deleted on 2026-10-23. Also deleted then: SA `dotnetapp-demo@` (with its 3 keys) and the one key of `jre-clipper-server@` (the SA itself remains, keyless). That sweep missed `github-action-1001185213@`, which Firebase's GitHub setup created in June 2025 with a never-expiring key stored as a repo secret. On 2026-10-27 its key and the secret were deleted and the SA was disabled. The project has no user-managed SA keys; keep it that way (CI uses Workload Identity Federation).
