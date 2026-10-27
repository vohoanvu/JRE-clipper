#!/usr/bin/env bash
# One-time, idempotent setup for the "My videos" page (listMyVideos / getVideoJob).
#   - SA jre-clip-reader@: reads Firestore, reads objects under edited-clips/ only, and signs
#     URLs via signBlob as itself (no key).
#   - Composite index videoJobs (userId ASC, createdAt DESC) in jre-clipper-db for listMyVideos.
#   - Keeps finished videos forever: drops the 8-day delete rule on edited-clips/ (other rules stay).
# Run from Git Bash or Linux with a gcloud login that can change IAM:  bash frontend-firebase/setup-clip-reader.sh
set -euo pipefail

P=gen-lang-client-demo
BUCKET=jre-processed-clips-bucker
SA="jre-clip-reader@${P}.iam.gserviceaccount.com"

gcloud iam service-accounts describe "$SA" --project="$P" >/dev/null 2>&1 ||
  gcloud iam service-accounts create jre-clip-reader --project="$P" --display-name="JRE clip reader (My videos, signed playback URLs)"

gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:$SA" --role=roles/datastore.viewer --condition=None --format=none
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:$SA" --role=roles/storage.objectViewer \
  --condition="title=edited-clips only,expression=resource.name.startsWith('projects/_/buckets/${BUCKET}/objects/edited-clips/')" --format=none
# Signed URLs are produced via IAM signBlob as itself.
gcloud iam service-accounts add-iam-policy-binding "$SA" --project="$P" --member="serviceAccount:$SA" \
  --role=roles/iam.serviceAccountTokenCreator --format=none

# Index creation fails if it already exists; that's fine.
gcloud firestore indexes composite create --project="$P" --database=jre-clipper-db --collection-group=videoJobs \
  --field-config=field-path=userId,order=ascending --field-config=field-path=createdAt,order=descending --async 2>&1 ||
  echo "(index probably exists already)"

LIFECYCLE=$(mktemp)
cat > "$LIFECYCLE" <<'EOF'
{"rule": [{"action": {"type": "SetStorageClass", "storageClass": "ARCHIVE"},
           "condition": {"matchesPrefix": ["utterance-embedding-results/", "segmented_transcripts/", "utterances-for-embedding/"],
                         "matchesStorageClass": ["STANDARD"]}}]}
EOF
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file="$LIFECYCLE"
rm -f "$LIFECYCLE"
