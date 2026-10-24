#!/bin/bash

# Script to check for missing videos in Google Cloud Storage and write URLs to download to youtube_urls.txt

# Configuration
source_file="jre_filtered_urls.txt"  # Source file with all YouTube URLs
output_file="youtube_urls.txt"  # Output file for URLs of videos not yet downloaded
gcloud_project="gen-lang-client-demo"  # Your Google Cloud project ID
gcloud_bucket="gs://jre-all-episodes"  # Your Google Cloud Storage bucket
gcloud_path="gcloud"  # Adjust if not in PATH, e.g., "/path/to/gcloud"

# Check if source file exists
if [ ! -f "$source_file" ]; then
    echo "Error: Source file $source_file not found in current directory!"
    exit 1
fi

# Read all URLs from source file, skipping empty lines
mapfile -t all_urls < <(grep -v '^$' "$source_file")
total_urls=${#all_urls[@]}
echo "Found $total_urls URLs in $source_file."

# Initialize counters and arrays
missing_urls=()
processed_count=0

# Get list of existing objects in GCS bucket
echo "Fetching list of existing objects in $gcloud_bucket... (this may take a while)"
existing_objects=$("$gcloud_path" storage ls "$gcloud_bucket/*.mp4" 2>/dev/null | grep -oP '(?<=gs://jre-all-episodes/)[^/]+')
if [ $? -ne 0 ]; then
    echo "Error: Failed to fetch existing objects from $gcloud_bucket. Check your permissions or network."
    exit 1
fi

# Extract video IDs from GCS filenames, handling different naming conventions
declare -A existing_videos
while IFS= read -r obj; do
    # Remove .mp4 extension
    obj_no_ext=$(echo "$obj" | sed 's/\.mp4$//')
    # Extract video ID: check if there's an underscore, take part before it; otherwise, take the whole name
    if [[ $obj_no_ext =~ ^([a-zA-Z0-9_-]+)_ ]]; then
        video_id="${BASH_REMATCH[1]}"
        echo "Extracted video ID $video_id from filename $obj (pattern: <videoId>_Title_Description.mp4)"
    elif [[ $obj_no_ext =~ ^([a-zA-Z0-9_-]+)$ ]]; then
        video_id="${BASH_REMATCH[1]}"
        echo "Extracted video ID $video_id from filename $obj (pattern: <videoId>.mp4)"
    else
        echo "Warning: Could not extract video ID from filename $obj. Skipping this object."
        continue
    fi
    existing_videos["$video_id"]=1
done <<< "$existing_objects"

echo "Found ${#existing_videos[@]} unique existing videos in $gcloud_bucket."

# Process each URL to check if the video is already in GCS
for url in "${all_urls[@]}"; do
    url=$(echo "$url" | xargs)  # Trim whitespace
    if [ -z "$url" ]; then continue; fi  # Skip empty lines

    # Extract Video ID from URL (assuming standard YouTube URL format)
    video_id=$(echo "$url" | grep -oP '(?<=v=)[^&]+')
    if [ -z "$video_id" ]; then
        echo "Warning: Could not extract Video ID from $url. Skipping."
        continue
    fi

    # Check if video ID exists in GCS bucket objects
    if [[ -n "${existing_videos[$video_id]}" ]]; then
        echo "Video $video_id already exists in $gcloud_bucket. Skipping."
    else
        echo "Video $video_id not found in $gcloud_bucket. Adding to download list."
        missing_urls+=("$url")
    fi

    ((processed_count++))
    # Print progress every 100 URLs to avoid flooding output
    if [ $((processed_count % 100)) -eq 0 ]; then
        echo "Processed $processed_count/$total_urls URLs..."
    fi
done

# Write missing URLs to output file
if [ ${#missing_urls[@]} -gt 0 ]; then
    echo "Writing ${#missing_urls[@]} missing URLs to $output_file."
    printf "%s\n" "${missing_urls[@]}" > "$output_file"
else
    echo "No missing URLs found. All videos from $source_file are already in $gcloud_bucket."
    # Create an empty file if no URLs are missing to avoid errors in other scripts
    touch "$output_file"
fi

echo "Process completed. Checked $processed_count URLs, found ${#missing_urls[@]} videos to download."