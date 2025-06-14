'''
Converts a JSON file containing an array of objects to a newline-delimited JSON (NDJSON) file.
'''
import json
import os
import sys

def convert_to_ndjson(input_file_path, output_file_path):
    '''
    Reads a JSON file expected to contain an array of objects and writes
    each object as a newline-delimited JSON to the output file.

    Args:
        input_file_path (str): Path to the input JSON file.
        output_file_path (str): Path to the output NDJSON file.
    '''
    try:
        with open(input_file_path, 'r', encoding='utf-8') as infile, \
             open(output_file_path, 'w', encoding='utf-8') as outfile:

            data = json.load(infile)

            if not isinstance(data, list):
                print(f"Error: Input file {input_file_path} does not contain a JSON array at the root.")
                # If it's a single object, we could technically write it as one line NDJSON
                # but the user's problem implies the files are arrays that BQ is misinterpreting.
                # For now, let's stick to the primary problem of converting arrays.
                # If it's a single object, it might already be fine for BQ if it's the *only* content.
                # However, BQ expects *multiple* objects, each on a new line for NDJSON.
                # If it's a single object and the user wants to upload many such files, they should
                # concatenate them line by line.
                # For this script, we focus on the array-to-NDJSON case.
                # If it's a single object, we can write it directly.
                # json.dump(data, outfile)
                # outfile.write('\n')
                # print(f"Warning: {input_file_path} was a single JSON object, wrote it as one line to {output_file_path}.")
                return False

            for item in data:
                json.dump(item, outfile) # Write the JSON object
                outfile.write('\n')      # Add a newline character
        print(f"Successfully converted {input_file_path} to {output_file_path}")
        return True
    except json.JSONDecodeError as e:
        print(f"Error decoding JSON from {input_file_path}: {e}")
        return False
    except Exception as e:
        print(f"An unexpected error occurred while processing {input_file_path}: {e}")
        return False

if __name__ == "__main__":
    # Base directory for transcriptions
    base_transcriptions_dir = "/Users/vohoanvu/dev-repository/JRE-clipper/transcriptions"
    # Directory to save converted NDJSON files
    output_ndjson_dir = "/Users/vohoanvu/dev-repository/JRE-clipper/transcriptions_ndjson"

    if not os.path.exists(base_transcriptions_dir):
        print(f"Error: Input directory not found: {base_transcriptions_dir}")
        sys.exit(1)

    if not os.path.exists(output_ndjson_dir):
        os.makedirs(output_ndjson_dir)
        print(f"Created output directory: {output_ndjson_dir}")

    print(f"Starting conversion of JSON files in '{base_transcriptions_dir}' to NDJSON in '{output_ndjson_dir}'")

    files_to_attempt = 0
    converted_this_run = 0
    skipped_files = 0
    failed_files_this_run = []
    total_json_files_in_source = 0

    source_files = [f for f in os.listdir(base_transcriptions_dir) if f.endswith(".json")]
    total_json_files_in_source = len(source_files)

    for filename in source_files:
        input_file = os.path.join(base_transcriptions_dir, filename)
        output_file = os.path.join(output_ndjson_dir, filename) 

        if os.path.exists(output_file):
            # Optional: print(f"Output file for {filename} already exists. Skipping.")
            skipped_files += 1
            continue
            
        print(f"Processing {filename}...")
        files_to_attempt += 1
        if convert_to_ndjson(input_file, output_file):
            converted_this_run +=1
        else:
            failed_files_this_run.append(filename)
    
    print("\\n--- Conversion Summary ---")
    print(f"Total JSON files in source directory: {total_json_files_in_source}")
    print(f"Files skipped (output already existed): {skipped_files}")
    print(f"Files attempted for conversion this run: {files_to_attempt}")
    print(f"Successfully converted this run: {converted_this_run}")
    print(f"Failed to convert this run: {len(failed_files_this_run)}")
    if failed_files_this_run:
        print("Files that failed in this run:")
        for f_name in failed_files_this_run:
            print(f"  - {f_name}")
    print(f"\\nConverted files are located in: {output_ndjson_dir}")
    print("Please use the files from this directory for your BigQuery upload.")
