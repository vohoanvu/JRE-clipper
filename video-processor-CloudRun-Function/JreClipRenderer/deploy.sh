#!/usr/bin/env bash
# Build, push and deploy the clip renderer Cloud Run Job.
#   ./deploy.sh            # tag = current git short SHA
#   ./deploy.sh v2         # explicit tag
#   ./deploy.sh --setup    # one-time: service account + IAM (idempotent), then deploy
# Local test (no cloud):  JOB_FILE=job.json SOURCE_ROOT=F:/jre-all-episodes OUTPUT_DIR=out dotnet run -c Release
set -euo pipefail

PROJECT=gen-lang-client-demo
REGION=us-central1
JOB=jre-clip-renderer
SA="jre-clip-renderer@${PROJECT}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/${JOB}"
cd "$(dirname "$0")"

if [[ "${1:-}" == "--setup" ]]; then
  shift
  gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$JOB" --project "$PROJECT" --display-name="JRE clip renderer (Cloud Run Job)"
  gcloud storage buckets add-iam-policy-binding gs://jre-all-episodes --member="serviceAccount:$SA" --role=roles/storage.objectViewer --format=none
  gcloud storage buckets add-iam-policy-binding gs://jre-processed-clips-bucker --member="serviceAccount:$SA" --role=roles/storage.objectUser --format=none
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role=roles/datastore.user --condition=None --format=none
  # Signed download URLs are produced via IAM signBlob as itself.
  gcloud iam service-accounts add-iam-policy-binding "$SA" --member="serviceAccount:$SA" --role=roles/iam.serviceAccountTokenCreator --format=none
fi

TAG="${1:-$(git rev-parse --short HEAD)}"
docker build -t "$IMAGE:$TAG" .
docker push "$IMAGE:$TAG"
DIGEST=$(gcloud artifacts docker images describe "$IMAGE:$TAG" --format="value(image_summary.digest)")

# Git Bash would rewrite the POSIX mount path into a Windows path; exclude just that flag.
MSYS2_ARG_CONV_EXCL="--add-volume-mount" gcloud run jobs deploy "$JOB" \
  --project="$PROJECT" --region="$REGION" --image="$IMAGE@$DIGEST" \
  --service-account="$SA" \
  --cpu=4 --memory=2Gi --task-timeout=30m --max-retries=1 --tasks=1 --parallelism=1 \
  --execution-environment=gen2 \
  --add-volume=name=sources,type=cloud-storage,bucket=jre-all-episodes,readonly=true \
  --add-volume-mount=volume=sources,mount-path=/jre-videos \
  --set-env-vars=MAX_RETRIES=1 \
  --labels=app=jre-clipper,component=clip-renderer

echo "Deployed $JOB -> $IMAGE@$DIGEST"
