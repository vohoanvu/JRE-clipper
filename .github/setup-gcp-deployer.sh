#!/usr/bin/env bash
# One-time, idempotent setup for keyless GitHub Actions deploys (Workload Identity Federation).
# Creates SA github-deployer@ with only deploy permissions, and lets GitHub's OIDC tokens for
# vohoanvu/JRE-clipper on refs/heads/master (matched by fixed repo/owner IDs) impersonate it.
# Run from Git Bash or Linux with a gcloud login that can change IAM:  bash .github/setup-gcp-deployer.sh
set -euo pipefail

P=gen-lang-client-demo
PN=408323719521
REPO_ID=1001185213   # gh api repos/vohoanvu/JRE-clipper -q .id
OWNER_ID=36556515    # gh api repos/vohoanvu/JRE-clipper -q .owner.id
SA="github-deployer@${P}.iam.gserviceaccount.com"

gcloud services enable sts.googleapis.com iamcredentials.googleapis.com --project="$P"

gcloud iam service-accounts describe "$SA" --project="$P" >/dev/null 2>&1 ||
  gcloud iam service-accounts create github-deployer --project="$P" --display-name="GitHub Actions deployer (keyless, master only)"

# Hosting, Functions (v2 runs on Cloud Run), the renderer Cloud Run Job, and the API checks firebase-tools does.
for role in roles/firebasehosting.admin roles/cloudfunctions.developer roles/run.developer \
            roles/serviceusage.serviceUsageConsumer roles/serviceusage.apiKeysViewer \
            roles/firebaseextensions.viewer; do
  gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:$SA" --role="$role" --condition=None --format=none
done
# firebase-tools reads the cleanup policy of the functions image repo before a functions deploy.
gcloud artifacts repositories add-iam-policy-binding gcf-artifacts --location=us-central1 --project="$P" \
  --member="serviceAccount:$SA" --role=roles/artifactregistry.reader --format=none
# Push renderer images (only to this repo).
gcloud artifacts repositories add-iam-policy-binding cloud-run-source-deploy --location=us-central1 --project="$P" \
  --member="serviceAccount:$SA" --role=roles/artifactregistry.writer --format=none
# Deploying a function or the job "as" its runtime service account requires actAs on that account.
# firebase-tools also pre-checks actAs on the App Engine default account before any functions deploy.
for runtime in "${PN}-compute@developer.gserviceaccount.com" "jre-search-reader@${P}.iam.gserviceaccount.com" \
               "jre-clip-renderer@${P}.iam.gserviceaccount.com" "jre-clip-reader@${P}.iam.gserviceaccount.com" \
               "${P}@appspot.gserviceaccount.com"; do
  gcloud iam service-accounts add-iam-policy-binding "$runtime" --project="$P" \
    --member="serviceAccount:$SA" --role=roles/iam.serviceAccountUser --format=none
done

gcloud iam workload-identity-pools describe github --project="$P" --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create github --project="$P" --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers describe jre-clipper --project="$P" --location=global --workload-identity-pool=github >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc jre-clipper --project="$P" --location=global \
    --workload-identity-pool=github --display-name="vohoanvu/JRE-clipper" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository_id == '${REPO_ID}' && assertion.repository_owner_id == '${OWNER_ID}' && assertion.ref == 'refs/heads/master'"
gcloud iam service-accounts add-iam-policy-binding "$SA" --project="$P" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PN}/locations/global/workloadIdentityPools/github/attribute.repository_id/${REPO_ID}" \
  --format=none

echo "GCP_WIF_PROVIDER=projects/${PN}/locations/global/workloadIdentityPools/github/providers/jre-clipper"
echo "GCP_DEPLOY_SA=${SA}"
