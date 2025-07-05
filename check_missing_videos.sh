#!/bin/bash

# List of all expected video IDs
declare -a ALL_VIDEO_IDS=("ws2ZsG3NNQc" "COyRH27wc84" "6G59zsjM2UI" "WHBfB7usIcU" "HwyAX69xG1Q" 
                          "qe64ayAbDjM" "TOiTI5LrCSA" "8M8jBaA8_Gk" "ETEUC8AcjwU" "ELGY6HfkENg" 
                          "qVEwIx2uG1A" "hgdJnpVccWg" "K1VZq949niU" "aC7p0Upkh34" "mgVpwYUrsRU" 
                          "IVZ-qJ92y2I" "hOnefFVBEb0" "x2qwRJT4WGY" "02ux1dKNPXo" "5VoVIpIzj_c")

# Output file for missing videos
OUTPUT_FILE="missing_videos.txt"

# Get the list of MP4 files from the GCS bucket
echo "Fetching MP4 files from GCS bucket..."
MP4_FILES=$(gcloud storage ls "gs://jre-all-episodes/*.mp4" 2>/dev/null)

if [ $? -ne 0 ]; then
  echo "Error: Failed to access GCS bucket. Please check your authentication and permissions."
  exit 1
fi

# Extract video IDs from the GCS file list
declare -a EXISTING_VIDEO_IDS=()
while IFS= read -r file; do
  # Extract the filename from the path
  filename=$(basename "$file")
  # Extract video ID using regex pattern matching
  if [[ $filename =~ ^([a-zA-Z0-9_-]+)_ ]]; then
    video_id="${BASH_REMATCH[1]}"
    EXISTING_VIDEO_IDS+=("$video_id")
  fi
done <<< "$MP4_FILES"

echo "Found ${#EXISTING_VIDEO_IDS[@]} videos in the bucket"

# Find missing video IDs
declare -a MISSING_VIDEO_IDS=()
for id in "${ALL_VIDEO_IDS[@]}"; do
  found=false
  for existing_id in "${EXISTING_VIDEO_IDS[@]}"; do
    if [ "$id" == "$existing_id" ]; then
      found=true
      break
    fi
  done
  
  if [ "$found" == false ]; then
    MISSING_VIDEO_IDS+=("$id")
  fi
done

# Generate YouTube URLs for missing videos
echo "Generating YouTube URLs for missing videos..."
for id in "${MISSING_VIDEO_IDS[@]}"; do
  youtube_url="https://www.youtube.com/watch?v=$id"
  echo "$youtube_url" >> "$OUTPUT_FILE"
  echo "Missing: $youtube_url"
done

echo "Found ${#MISSING_VIDEO_IDS[@]} missing videos"
echo "Results written to $OUTPUT_FILE"