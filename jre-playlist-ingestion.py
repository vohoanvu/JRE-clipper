import csv
import googleapiclient.discovery
import os
import json
import glob

# Configuration
API_KEY = "AIzaSyDINU6PKYWJewuYqNLDI3NEYumStT4bIDk" 
PLAYLIST_ID = "PLk1Sqn_f33KuWf3tW9BBe_4TP7x8l0m3T"  # The JRE Playlist ID
CHANNEL_ID = "UCzQUP1qoWDoEbmsQxvdjxgQ"  # the JRE Channel ID
OUTPUT_CSV = "jre-playlist.csv"  # Output file in the same directory

# Set up the YouTube API client
youtube = googleapiclient.discovery.build("youtube", "v3", developerKey=API_KEY)

def get_processed_video_ids():
    """Scan the ./results directory and return a list of videos from transcript JSON files and a set of videoIds."""
    existing_videos = []  # List to store video dictionaries
    existing_ids = set()  # Set to store video IDs
    transcript_files = glob.glob(os.path.join('./results', 'transcript-*.json'))  # Get all transcript JSON files
    
    for file_path in transcript_files:
        try:
            with open(file_path, 'r', encoding='utf-8') as jsonfile:
                data = json.load(jsonfile)
                if isinstance(data, list) and len(data) > 0:  # Ensure it's a valid transcript record
                    first_item = data[0]
                    video_id = os.path.basename(file_path).replace('transcript-', '').replace('.json', '')  # Extract videoId from filename
                    video = {
                        "videoId": video_id,
                        "title": first_item.get('videoTitle', 'Unknown Title'),  # Extract from JSON if available
                    }
                    existing_videos.append(video)
                    existing_ids.add(video_id)
        except (json.JSONDecodeError, FileNotFoundError, KeyError) as e:
            print(f"Error processing file {file_path}: {e} - Skipping.")
    
    return existing_videos, existing_ids  # Return the list and set

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
    if not videos:  # New check: If videos list is empty, don't write and log a warning
        print("Warning: No videos to write. Skipping CSV update to prevent data loss.")
        return  # Exit the function without writing
    
    fieldnames = ["videoId", "title", "description", "date", "Url", "isTranscripted", "isVectorized", "isEmptyTranscript"]
    try:
        with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            writer.writeheader()  # Write the header row
            print(f"Writing {len(videos)} videos to CSV...")  # Debugging print
            for video in videos:
                video_copy = video.copy()  # Avoid modifying original data
                video_copy['Url'] = f"https://www.youtube.com/watch?v={video_copy['videoId']}"
                video_copy['isTranscripted'] = str(is_transcripted(video_copy['videoId']))
                video_copy['isVectorized'] = 'False'
                
                transcript_file_path = os.path.join('./results', f"transcript-{video_copy['videoId']}.json")
                if os.path.exists(transcript_file_path):  # Check if file exists
                    try:
                        with open(transcript_file_path, 'r', encoding='utf-8') as jsonfile:
                            data = json.load(jsonfile)
                            if (isinstance(data, list) and len(data) > 0 and
                                data[0].get('transcript') == '' and
                                data[0].get('transcriptWithTimestamps') == []):
                                video_copy['isEmptyTranscript'] = 'True'  # Corrupted transcript
                            else:
                                video_copy['isEmptyTranscript'] = 'False'
                    except json.JSONDecodeError as e:
                        print(f"Error reading JSON for {video_copy['videoId']}: {e}")
                        video_copy['isEmptyTranscript'] = 'False'  # Treat as not corrupted
                else:
                    video_copy['isEmptyTranscript'] = 'False'  # File doesn't exist
                
                writer.writerow(video_copy)
        print(f"Export complete. Data written to {OUTPUT_CSV} with updates.")
    except PermissionError as e:
        print(f"Permission denied when trying to write to {OUTPUT_CSV}. Error: {e}")
        print("Please check if the file is open in another application or if you have write permissions.")
        print("You can try: ls -l jre-playlist.csv to check permissions, or chmod 644 jre-playlist.csv to adjust.")
    except Exception as e:
        print(f"An error occurred while writing to CSV: {e}")

if __name__ == "__main__":
    print("Checking for new videos...")
    existing_videos, existing_ids = get_processed_video_ids()  # Corrected call without arguments
    
    print("Fetching videos from playlist...")
    fetched_videos = fetch_playlist_items()
    print(f"Fetched {len(fetched_videos)} videos from playlist.")  # Log fetched videos
    
    fetched_videos_dict = {video['videoId']: video for video in fetched_videos}  # Create a dict for fetched videos
    
    all_videos = list(fetched_videos_dict.values())  # Start with fetched videos as base
    added_count = 0
    for video in existing_videos:
        if video['videoId'] not in fetched_videos_dict:  # Only add if not in fetched
            all_videos.append(video)
            added_count += 1
    
    if added_count > 0:
        print(f"Added {added_count} existing videos for consolidation with the dataset.")
    else:
        print("No new existing videos to add. Consolidating with fetched videos.")
    
    if len(fetched_videos) > 0:
        print(f"Updating CSV with {len(all_videos)} videos, including newly fetched videos.")
    else:
        print("No videos fetched. The dataset is being consolidated with existing records only.")
    
    write_to_csv(all_videos)  # Write the final list
