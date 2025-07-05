#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# Set your Google Cloud project details
export PROJECT_ID="gen-lang-client-demo"
export REGION="us-central1"
export REPOSITORY="cloud-run-source-deploy"
export IMAGE_NAME="video-processor-service-dotnet"
# Use a unique tag based on the current timestamp
export TAG=$(date +%Y%m%d-%H%M%S)
export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/$IMAGE_NAME:$TAG"

# Configure gcloud to use your project
gcloud config set project $PROJECT_ID

# Configure Docker to use gcloud for authentication
gcloud auth configure-docker $REGION-docker.pkg.dev

# Create the Artifact Registry repository if it doesn't exist
gcloud artifacts repositories create $REPOSITORY \
    --repository-format=docker \
    --location=$REGION \
    --description="Docker repository for JRE video processing" || echo "Repository $REPOSITORY already exists."

# Build the Docker image, pointing to the directory containing the Dockerfile
docker build -t $IMAGE_URI ./JreVideoProcessor

# Push the Docker image to Artifact Registry
docker push $IMAGE_URI

echo "--------------------------------------------------"
echo "Successfully pushed Docker image."
echo "Use this full image name for your deployment:"
echo "$IMAGE_URI"
echo "--------------------------------------------------"