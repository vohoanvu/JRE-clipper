#!/bin/bash
# Download missing YouTube videos and upload to GCS bucket

# Configuration
MISSING_VIDEOS_FILE="missing_videos.txt"
GCS_BUCKET="gs://jre-all-episodes/"
TEMP_DIR="./temp_downloads"
LOG_FILE="download_log.txt"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to log messages
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Function to cleanup temporary files
cleanup() {
    log_message "Cleaning up temporary files..."
    rm -rf "$TEMP_DIR"
}

# Set up cleanup trap
trap cleanup EXIT

# Check if required tools are installed
check_dependencies() {
    log_message "Checking dependencies..."
    
    if ! command -v yt-dlp &> /dev/null; then
        echo -e "${RED}Error: yt-dlp is not installed. Please install it first.${NC}"
        echo "Install with: brew install yt-dlp"
        exit 1
    fi
    
    if ! command -v gcloud &> /dev/null; then
        echo -e "${RED}Error: gcloud is not installed or not in PATH.${NC}"
        exit 1
    fi
    
    log_message "All dependencies found."
}

# Check if missing videos file exists
check_input_file() {
    if [ ! -f "$MISSING_VIDEOS_FILE" ]; then
        echo -e "${RED}Error: $MISSING_VIDEOS_FILE not found.${NC}"
        echo "Please run check_missing_videos.sh first to generate the missing videos list."
        exit 1
    fi
    
    # Count non-empty lines (excluding header)
    video_count=$(grep -v "^Missing Videos" "$MISSING_VIDEOS_FILE" | grep -v "^$" | wc -l | tr -d ' ')
    
    if [ "$video_count" -eq 0 ]; then
        echo -e "${YELLOW}No missing videos found in $MISSING_VIDEOS_FILE${NC}"
        exit 0
    fi
    
    log_message "Found $video_count missing videos to download."
}

# Create temporary directory
setup_temp_dir() {
    log_message "Setting up temporary directory..."
    mkdir -p "$TEMP_DIR"
    cd "$TEMP_DIR"
}

# Download a single video
download_video() {
    local url="$1"
    local video_id
    
    # Extract video ID from URL
    video_id=$(echo "$url" | grep -o 'v=[^&]*' | cut -d'=' -f2)
    
    if [ -z "$video_id" ]; then
        log_message "ERROR: Could not extract video ID from URL: $url"
        return 1
    fi
    
    log_message "Downloading video ID: $video_id"
    echo -e "${YELLOW}Downloading: $url${NC}"
    
    # Download with yt-dlp using the specified format
    yt-dlp -f 'bestvideo[height<=720]+bestaudio/best[height<=720]' \
           -o "${video_id}_%(title)s.%(ext)s" \
           --merge-output-format mp4 \
           --no-playlist \
           "$url"
    
    if [ $? -eq 0 ]; then
        log_message "SUCCESS: Downloaded video $video_id"
        return 0
    else
        log_message "ERROR: Failed to download video $video_id"
        return 1
    fi
}

# Upload files to GCS bucket
upload_to_gcs() {
    log_message "Uploading downloaded files to GCS bucket..."
    
    # Count MP4 files in temp directory
    mp4_count=$(find . -name "*.mp4" -type f | wc -l | tr -d ' ')
    
    if [ "$mp4_count" -eq 0 ]; then
        log_message "WARNING: No MP4 files found to upload."
        return 1
    fi
    
    log_message "Found $mp4_count MP4 files to upload."
    
    # Upload all MP4 files
    for file in *.mp4; do
        if [ -f "$file" ]; then
            echo -e "${YELLOW}Uploading: $file${NC}"
            gcloud storage cp "$file" "$GCS_BUCKET"
            
            if [ $? -eq 0 ]; then
                log_message "SUCCESS: Uploaded $file to GCS"
            else
                log_message "ERROR: Failed to upload $file to GCS"
            fi
        fi
    done
    
    log_message "Upload process completed."
}

# Main execution
main() {
    log_message "Starting download process..."
    
    # Check dependencies and input file
    check_dependencies
    check_input_file
    
    # Setup working directory
    setup_temp_dir
    
    # Download each video
    local success_count=0
    local error_count=0
    
    while IFS= read -r line; do
        # Skip empty lines and header
        if [[ -z "$line" || "$line" == "Missing Videos"* ]]; then
            continue
        fi
        
        # Check if it's a valid YouTube URL
        if [[ "$line" =~ ^https://www\.youtube\.com/watch\?v= ]]; then
            if download_video "$line"; then
                ((success_count++))
            else
                ((error_count++))
            fi
        else
            log_message "WARNING: Skipping invalid URL: $line"
        fi
        
        # Small delay between downloads to be respectful
        sleep 2
        
    done < "../$MISSING_VIDEOS_FILE"
    
    # Upload to GCS
    upload_to_gcs
    
    # Final summary
    log_message "Download process completed!"
    log_message "Successfully downloaded: $success_count videos"
    log_message "Failed downloads: $error_count videos"
    
    if [ $success_count -gt 0 ]; then
        echo -e "${GREEN}Successfully processed $success_count videos!${NC}"
    fi
    
    if [ $error_count -gt 0 ]; then
        echo -e "${RED}Failed to download $error_count videos. Check $LOG_FILE for details.${NC}"
    fi
}

# Run main function
main
