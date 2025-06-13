import csv
import googleapiclient.discovery
import os

# Configuration
API_KEY = "AIzaSyDINU6PKYWJewuYqNLDI3NEYumStT4bIDk" 
PLAYLIST_ID = "PLk1Sqn_f33KuWf3tW9BBe_4TP7x8l0m3T"  # The JRE Playlist ID
CHANNEL_ID = "UCzQUP1qoWDoEbmsQxvdjxgQ"  # the JRE Channel ID
OUTPUT_CSV = "jre-playlist.csv"  # Output file in the same directory

# Set up the YouTube API client
youtube = googleapiclient.discovery.build("youtube", "v3", developerKey=API_KEY)

def get_processed_video_ids(output_csv):
    """Read existing CSV and return a list of videos and a set of videoIds."""
    if os.path.exists(output_csv):
        with open(output_csv, 'r', encoding='utf-8') as csvfile:
            reader = csv.DictReader(csvfile)
            existing_videos = list(reader)  # List of dictionaries
            existing_ids = {video['videoId'] for video in existing_videos if 'videoId' in video}
            return existing_videos, existing_ids
    return [], set()  # Return empty if CSV doesn't exist

def fetch_playlist_items():
    videos = []  # List to store video data
    next_page_token = None
    
    while True:
        request = youtube.playlistItems().list(
            part="snippet",
            playlistId=PLAYLIST_ID,
            maxResults=50,  # API limit per request
            pageToken=next_page_token
        )
        response = request.execute()
        
        for item in response.get("items", []):
            snippet = item["snippet"]
            video = {
                "videoId": snippet["resourceId"]["videoId"],
                "title": snippet["title"],
                "description": snippet["description"],
                "date": snippet["publishedAt"]  # ISO 8601 format
            }
            videos.append(video)
        
        next_page_token = response.get("nextPageToken")
        
        if not next_page_token:
            break  # No more pages
    return videos

def is_transcripted(video_id):
    transcript_file = os.path.join('./results', f"transcript-{video_id}.json")
    return os.path.exists(transcript_file)

def write_to_csv(videos):
    fieldnames = ["videoId", "title", "description", "date", "Url", "isTranscripted"]
    try:
        with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            writer.writeheader()  # Write the header row
            for video in videos:
                video_copy = video.copy()  # Avoid modifying original data
                video_copy['Url'] = f"https://www.youtube.com/watch?v={video_copy['videoId']}"
                video_copy['isTranscripted'] = str(is_transcripted(video_copy['videoId']))  # Convert boolean to string for CSV
                writer.writerow(video_copy)  # Write each video's data with new columns
        print(f"Export complete. Data written to {OUTPUT_CSV} with updates.")
    except PermissionError as e:
        print(f"Permission denied when trying to write to {OUTPUT_CSV}. Error: {e}")
        print("Please check if the file is open in another application or if you have write permissions.")
        print("You can try: ls -l jre-playlist.csv to check permissions, or chmod 644 jre-playlist.csv to adjust.")
    except Exception as e:
        print(f"An error occurred while writing to CSV: {e}")

if __name__ == "__main__":
    # Update main to check for new videos before processing
    print("Checking for new videos...")
    existing_videos, existing_ids = get_processed_video_ids(OUTPUT_CSV)
    
    print("Fetching videos from playlist...")
    fetched_videos = fetch_playlist_items()
    
    new_videos = [video for video in fetched_videos if video['videoId'] not in existing_ids]
    
    if new_videos:
        print(f"Found {len(new_videos)} new videos. Updating CSV...")
        all_videos = existing_videos + new_videos  # Combine existing and new
        write_to_csv(all_videos)  # Write updated list with new columns
        print(f"Export complete. Data written to {OUTPUT_CSV} with updates including new videos.")
    else:
        print("No new videos found. Updating existing CSV with current transcription status...")
        write_to_csv(existing_videos)  # Update existing records with current status
        print(f"CSV has been updated with the latest transcription status.")
