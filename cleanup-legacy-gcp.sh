#!/bin/bash
# Removes GCP resources left over from the Pub/Sub + Cloud Run service clipper and the public token endpoint.
# Run only AFTER the new stack is deployed (jre-clip-renderer job, createVideoJob + search proxy functions, new hosting).
#   ./cleanup-legacy-gcp.sh              # dry run: prints what would be deleted
#   ./cleanup-legacy-gcp.sh --apply      # deletes
#   ./cleanup-legacy-gcp.sh --apply --clip-lifecycle   # also auto-delete rendered clips after 8 days (signed URLs expire at 7)

project="gen-lang-client-demo"
region="us-central1"
apply=false
clip_lifecycle=false
for arg in "$@"; do
    case "$arg" in
        --apply) apply=true ;;
        --clip-lifecycle) clip_lifecycle=true ;;
    esac
done

run() {
    if $apply; then
        echo "+ $*"
        "$@" || echo "  (failed or already gone, continuing)"
    else
        echo "[dry-run] $*"
    fi
}

# Eventarc triggers for the old Pub/Sub flow. Seven point at Cloud Run services that no longer exist;
# deleting a trigger also deletes its push subscription.
for trigger in trigger-video-editing-job video-processor-trigger trigger-vfmc2emc trigger-video-editing \
               segments-editing-trigger trigger-jre-video-processor dotnet-processor-trigger \
               jre-video-processing-trigger jre-video-processor-trigger jre-video-clipping-trigger; do
    run gcloud eventarc triggers delete "$trigger" --location="$region" --project="$project" --quiet
done

# Any push subscriptions still attached to deleted topics.
for sub in $(gcloud pubsub subscriptions list --project="$project" --format="value(name)" --filter="topic:_deleted-topic_"); do
    run gcloud pubsub subscriptions delete "$sub" --project="$project" --quiet
done
run gcloud pubsub topics delete video-editing-job --project="$project" --quiet

# Retired clipper services (replaced by the jre-clip-renderer Cloud Run Job + createVideoJob function).
run gcloud run services delete segment-editing-job-dotnet --region="$region" --project="$project" --quiet
run gcloud run services delete jre-video-processor-py --region="$region" --project="$project" --quiet

# Public token endpoint (stopgap version deployed with gcloud, so firebase deploy won't remove it).
run gcloud functions delete getVertexAiToken --region="$region" --project="$project" --gen2 --quiet

# The old clipper's service account has no remaining users.
run gcloud iam service-accounts delete "dotnetapp-demo@${project}.iam.gserviceaccount.com" --project="$project" --quiet

if $clip_lifecycle; then
    lifecycle_file=$(mktemp)
    cat > "$lifecycle_file" <<'EOF'
{"rule": [{"action": {"type": "Delete"}, "condition": {"age": 8, "matchesPrefix": ["edited-clips/"]}}]}
EOF
    run gcloud storage buckets update gs://jre-processed-clips-bucker --lifecycle-file="$lifecycle_file" --project="$project"
    rm -f "$lifecycle_file"
fi

$apply || echo "Dry run only. Re-run with --apply to delete."
