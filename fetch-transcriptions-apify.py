import csv
import os
import json
import time
import glob
import re
from apify_client import ApifyClient
import asyncio
from urllib.parse import urlparse, parse_qs

# Configuration
API_TOKEN = "apify_api_a0zhgb3vyCniOOuAjO7XwXmpWTUaMG02olg6"
INPUT_CSV = 'jre-playlist.csv'
OUTPUT_DIR = './results'

def get_processed_video_ids(output_dir):
    """Scan the output directory and return a set of processed video IDs from filenames."""
    processed_ids = set()
    pattern = re.compile(r'transcript-([a-zA-Z0-9_-]+)\.json')  # Regex to match 'transcript-<videoId>.json'
    if os.path.exists(output_dir):
        files = glob.glob(os.path.join(output_dir, 'transcript-*.json'))
        for file in files:
            filename = os.path.basename(file)
            match = pattern.match(filename)
            if match:
                processed_ids.add(match.group(1))  # Add the video ID to the set
    return processed_ids

def extract_video_id(url):
    """Extract videoId from a YouTube URL."""
    parsed_url = urlparse(url)
    query_params = parse_qs(parsed_url.query)
    video_id = query_params.get('v', [None])[0]  # Get the 'v' parameter
    if video_id:
        return video_id
    raise ValueError(f"Invalid YouTube URL: {url}")

async def fetch_transcription_async(url):
    client = ApifyClient(API_TOKEN)
    run_input = {
        "video_urls": [{"url": url}]
    }
    try:
        # Wrap synchronous calls with asyncio.to_thread to fix await errors
        run = await asyncio.to_thread(client.actor("fWIyRKfnKlxB1r5CX").call, run_input=run_input)
        dataset_id = run.get("defaultDatasetId")
        if dataset_id:
            items = await asyncio.to_thread(list, client.dataset(dataset_id).iterate_items())  # Convert iterator to list in a thread
            return items
        return None
    except Exception as e:
        print(f"Error fetching transcription for URL {url}: {e}")
        return None

async def main():
    if not os.path.exists(INPUT_CSV):
        print(f"Error: Input file '{INPUT_CSV}' not found.")
        return
    
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)  # Create the output directory if it doesn't exist
    
    processed_ids = get_processed_video_ids(OUTPUT_DIR)  # Get the set of already processed video IDs
    print(f"Already processed video total : {len(processed_ids)}")
    
    with open(INPUT_CSV, 'r', encoding='utf-8') as csvfile:
        reader = csv.DictReader(csvfile)
        if 'Url' not in reader.fieldnames:
            print("Error: 'Url' column not found in the CSV.")
            return
        if 'isTranscripted' not in reader.fieldnames:
            print("Error: 'isTranscripted' column not found in the CSV.")
            return
        
        urls_to_process = []
        for row in reader:
            if row.get('title') == "Private video":
                print(f"Skipping private video: {row.get('Url')}")
                continue  # Skip this row if it's a private video
            if row.get('isTranscripted', '').lower() != "false":
                print(f"Skipping already transcribed video: {row.get('Url')}")
                continue  # Skip if isTranscripted is not "false" (case-insensitive)
            url = row.get('Url')
            if url and extract_video_id(url) not in processed_ids:
                urls_to_process.append(url)  # Collect URLs to process
                print(f"Adding to process: {url} (not transcribed and not private)")
        
        print(f"Number of URLs to process: {len(urls_to_process)}")  # Print the count of URLs to be processed
        
        # Switch to asynchronous processing with concurrency limit
        semaphore = asyncio.Semaphore(1)  # Limit to 1 concurrent tasks to avoid Apify memory limits
        
        async def process_url(url):
            async with semaphore:  # Limit concurrency
                try:
                    video_id = extract_video_id(url)
                    print(f"Processing URL: {url} (Video ID: {video_id})")
                    transcription_data = await fetch_transcription_async(url)  # Use async function
                    if transcription_data:
                        output_file = os.path.join(OUTPUT_DIR, f"transcript-{video_id}.json")
                        with open(output_file, 'w', encoding='utf-8') as jsonfile:
                            json.dump(transcription_data, jsonfile, ensure_ascii=False, indent=4)
                        print(f"Transcription saved to {output_file}")
                    else:
                        print(f"No transcription data for {url}")
                except Exception as e:
                    print(f"Error processing {url}: {e}")
        
        tasks = [process_url(url) for url in urls_to_process]
        await asyncio.gather(*tasks)  # Run tasks concurrently
    
    print("Processing complete. Check the results directory for JSON files.")

if __name__ == '__main__':
    asyncio.run(main())