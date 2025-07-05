#!/bin/bash

# --- Configuration ---
BUCKET_NAME="jre-all-episodes"

# --- Safety Switch ---
# Set to 'true' to only print what the script would do.
# Set to 'false' to execute the gcloud storage cp/rm commands.
DRY_RUN=false

# --- Script Logic ---

echo "Starting final rename for bucket: gs://${BUCKET_NAME}"
echo "Applying pattern: {videoId}_JRE{episodeNumber}_{Guest1-Guest2}.mp4"
if [ "$DRY_RUN" = true ]; then
  echo "--- DRY RUN MODE: Review changes below. No files will be renamed. ---"
fi
echo "-----------------------------------------------------------------------"

# Find all objects that still have the JRE# pattern
gcloud storage ls "gs://${BUCKET_NAME}/**JRE#*.mp4" | while read -r source_object; do

  # Get just the filename from the full GCS URI
  filename=$(basename "$source_object")

  # --- Create the new, safe filename ---
  # This single 'sed' command does all the transformations at once:
  # 1. Replaces the "#" with nothing.
  # 2. Replaces ", " and ": " separators with a hyphen.
  # 3. Removes all spaces.
  new_basename=$(echo "$filename" | sed -e 's/#//g' -e 's/, /-/g' -e 's/: /-/g' -e 's/ //g')

  # Ensure we only act if a change is needed
  if [[ "$filename" != "$new_basename" ]]; then
    dest_object="gs://${BUCKET_NAME}/${new_basename}"

    echo "Original:  $filename"
    echo "New Name:  $new_basename"

    if [ "$DRY_RUN" = false ]; then
      # Perform the copy and remove operation
      gcloud storage cp "${source_object}" "${dest_object}" -q && \
      gcloud storage rm "${source_object}" -q
      echo "Status:    RENAME COMPLETE"
    else
      echo "Status:    DRY RUN - No action taken."
    fi
    echo "-----------------------------------------------------------------------"
  fi
done

echo "Final rename process finished."