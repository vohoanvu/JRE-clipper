import os
import json
import glob
import csv

def find_corrupted_files(directory):
    corrupted_files = []
    if not os.path.exists(directory):
        print(f"Directory {directory} does not exist.")
        return corrupted_files  # Return empty list if directory doesn't exist
    
    json_files = glob.glob(os.path.join(directory, '*.json'))  # Get all .json files in the directory
    
    for file_path in json_files:
        if not os.path.exists(file_path):  # Double-check file existence
            print(f"File {file_path} does not exist, skipping.")
            continue
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # Check if data is a non-empty list and the first item has the required structure
                if isinstance(data, list) and len(data) > 0:
                    first_item = data[0]
                    if ('transcript' in first_item and first_item['transcript'] == '' and
                        'transcriptWithTimestamps' in first_item and first_item['transcriptWithTimestamps'] == []):
                        corrupted_files.append(file_path)
                        print(f"Adding corrupted file: {file_path} (confirmed empty transcript and timestamps)")
                    #else:
                        #print(f"File {file_path} does not meet corruption criteria.")
                # If data is not a list or is empty, skip it
        except (json.JSONDecodeError, FileNotFoundError) as e:
            print(f"Error reading {file_path}: {e} - Skipping file.")
    
    return corrupted_files

def count_private_videos(csv_file):
    private_count = 0
    try:
        with open(csv_file, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)  # Use DictReader for column access
            for row in reader:
                if row.get('title') == "Private video":  # Check 'title' column
                    private_count += 1
    except FileNotFoundError:
        print(f"Error: {csv_file} not found.")
    except Exception as e:
        print(f"Error reading {csv_file}: {e}")
    
    return private_count

def count_non_transcribed_non_private_videos(csv_file):
    count = 0
    try:
        with open(csv_file, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)  # Use DictReader for column access
            if 'isTranscripted' not in reader.fieldnames or 'title' not in reader.fieldnames or 'videoId' not in reader.fieldnames:
                print("Error: Required columns ('isTranscripted', 'title', or 'videoId') are missing in the CSV.")
                return 0  # Return 0 if columns are missing
            
            for row in reader:
                is_transcribed_value = row.get('isTranscripted', '').lower()  # Convert to lowercase for case-insensitive check
                if is_transcribed_value == "false" and row.get('title', '') != "Private video":
                    count += 1  # Increment for non-transcribed and non-private rows
                    video_url = f"https://www.youtube.com/watch?v={row.get('videoId')}"  # Construct and print the URL
                    print(f"Non-transcribed, non-private video URL: {video_url}")
    except FileNotFoundError:
        print(f"Error: {csv_file} not found.")
    except Exception as e:
        print(f"Error reading {csv_file}: {e}")
    
    return count

if __name__ == "__main__":
    results_directory = './results'
    corrupted = find_corrupted_files(results_directory)
    
    if corrupted:
        corrupted_videos_count = len(corrupted)
        print("Corrupted files found:")
        for file in corrupted:
            print(file)
        
        # Optionally, save the list to a file for easy deletion
        with open('corrupted_files.txt', 'w') as f:
            for file in corrupted:
                f.write(file + '\n')
        print(f"Number of corrupted (empty transcript) videos: {corrupted_videos_count}")
        print("List of corrupted files saved to 'corrupted_files.txt'.")
    else:
        print("No corrupted files found.")
    
    csv_file = 'jre-playlist.csv'  # Path to the CSV file
    private_videos_count = count_private_videos(csv_file)
    print(f"Number of private videos in {csv_file}: {private_videos_count}")
    
    non_transcribed_non_private_count = count_non_transcribed_non_private_videos(csv_file)
    print(f"Number of non-transcribed non-private videos in {csv_file}: {non_transcribed_non_private_count}")