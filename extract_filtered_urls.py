import pandas as pd

def extract_filtered_urls(csv_file_path, output_txt_path):
    """
    Extracts URLs from CSV where isTranscripted=True, isVectorized=True, and isEmptyTranscript=False
    
    Args:
        csv_file_path (str): Path to the CSV file
        output_txt_path (str): Path for the output text file
    """
    try:
        # Read the CSV file
        df = pd.read_csv(csv_file_path)
        
        # Display initial stats
        print(f"Reading CSV file: {csv_file_path}")
        print(f"Total rows in CSV: {len(df)}")
        print(f"Columns: {list(df.columns)}")
        
        # Check if required columns exist
        required_columns = ['Url', 'isTranscripted', 'isVectorized', 'isEmptyTranscript']
        missing_columns = [col for col in required_columns if col not in df.columns]
        
        if missing_columns:
            print(f"Error: Missing required columns: {missing_columns}")
            return
        
        # Convert boolean columns (they might be strings 'True'/'False')
        for col in ['isTranscripted', 'isVectorized', 'isEmptyTranscript']:
            if df[col].dtype == 'object':  # String type
                df[col] = df[col].astype(str).str.lower() == 'true'
        
        # Display current status
        print(f"\nCurrent data status:")
        print(f"isTranscripted=True: {(df['isTranscripted'] == True).sum()}")
        print(f"isVectorized=True: {(df['isVectorized'] == True).sum()}")
        print(f"isEmptyTranscript=False: {(df['isEmptyTranscript'] == False).sum()}")
        
        # Apply filters: isTranscripted=True AND isVectorized=True AND isEmptyTranscript=False
        filtered_df = df[
            (df['isTranscripted'] == True) & 
            (df['isVectorized'] == True) & 
            (df['isEmptyTranscript'] == False)
        ]
        
        print(f"\nRows matching all criteria: {len(filtered_df)}")
        
        # Extract URLs and remove any NaN values
        urls = filtered_df['Url'].dropna().tolist()
        
        print(f"Valid URLs found: {len(urls)}")
        
        # Write URLs to text file (one URL per line)
        with open(output_txt_path, 'w', encoding='utf-8') as f:
            for url in urls:
                f.write(f"{url}\n")
        
        print(f"\nSuccessfully saved {len(urls)} URLs to {output_txt_path}")
        
        # Display first few URLs as preview
        if urls:
            print(f"\nFirst 5 URLs:")
            for i, url in enumerate(urls[:5]):
                print(f"  {i+1}. {url}")
        
    except FileNotFoundError:
        print(f"Error: File {csv_file_path} not found.")
    except Exception as e:
        print(f"Error: {str(e)}")

if __name__ == "__main__":
    # Input and output file paths
    csv_file_path = "./jre-playlist_cleaned.csv"
    output_txt_path = "./jre_filtered_urls.txt"
    
    # Extract filtered URLs
    extract_filtered_urls(csv_file_path, output_txt_path)
