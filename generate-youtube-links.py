import csv
import os

# Configuration
INPUT_CSV = 'jre-playlist.csv'  # Input file
OUTPUT_CSV = 'jre-youtube-links.csv'  # Output file

def main():
    if not os.path.exists(INPUT_CSV):
        print(f"Error: Input file '{INPUT_CSV}' not found.")
        return
    
    video_urls = []  # List to store the generated URLs
    
    with open(INPUT_CSV, 'r', encoding='utf-8') as csvfile:
        reader = csv.DictReader(csvfile)  # Assumes the CSV has headers
        if 'videoId' not in reader.fieldnames:
            print("Error: 'videoId' column not found in the CSV.")
            return
        
        for row in reader:
            video_id = row.get('videoId')  # Get the videoId from the row
            if video_id:  # Ensure videoId is not empty
                url = f"https://www.youtube.com/watch?v={video_id}"
                video_urls.append({'video_url': url})  # Add to list
    
    if not video_urls:
        print("No video IDs found in the CSV.")
        return
    
    with open(OUTPUT_CSV, 'w', newline='', encoding='utf-8') as csvfile:
        fieldnames = ['video_url']  # Single column
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        writer.writeheader()  # Write the header
        for item in video_urls:
            writer.writerow(item)  # Write each row
    
    print(f"Processing complete. URLs have been written to '{OUTPUT_CSV}'.")

if __name__ == '__main__':
    main()
