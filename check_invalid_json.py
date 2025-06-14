'''
Script to validate JSON files in a directory and report invalid ones.
'''
import json
import os

def validate_json_files(directory_path):
    '''
    Validates all .json files in the specified directory.

    Args:
        directory_path (str): The path to the directory containing JSON files.

    Returns:
        list: A list of file paths that are not valid JSON.
    '''
    invalid_json_files = []
    if not os.path.isdir(directory_path):
        print(f"Error: Directory not found at '{directory_path}'")
        return invalid_json_files

    print(f"Scanning directory: {directory_path}")
    for filename in os.listdir(directory_path):
        if filename.endswith(".json"):
            file_path = os.path.join(directory_path, filename)
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    json.load(f)
                # print(f"Successfully validated: {filename}") # Optional: for verbose output
            except json.JSONDecodeError as e:
                print(f"Invalid JSON in file: {filename} - Error: {e}")
                invalid_json_files.append(file_path)
            except Exception as e:
                print(f"Could not read or process file: {filename} - Error: {e}")
                invalid_json_files.append(file_path) # Also consider other errors as problematic

    return invalid_json_files

if __name__ == "__main__":
    # Assuming the transcriptions directory is in the same parent directory as the script
    # or provide an absolute path.
    current_script_dir = os.path.dirname(__file__)
    transcriptions_dir = os.path.join(current_script_dir, "transcriptions")

    # For a fixed path as in the user's request:
    # transcriptions_dir = "/Users/vohoanvu/dev-repository/JRE-clipper/transcriptions/"

    if not os.path.exists(transcriptions_dir):
        print(f"Transcription directory not found: {transcriptions_dir}")
        print("Please ensure the 'transcriptions' directory exists in the correct location.")
    else:
        print(f"Starting JSON validation in: {transcriptions_dir}")
        corrupted_files = validate_json_files(transcriptions_dir)

        if corrupted_files:
            print("\n--- Summary of Invalid JSON Files ---")
            for f_path in corrupted_files:
                print(f_path)
            # Optionally, write to a file
            output_error_file = os.path.join(current_script_dir, "corrupted_transcripts_report.txt")
            with open(output_error_file, 'w', encoding='utf-8') as report_file:
                report_file.write("List of corrupted or unreadable JSON transcript files:\n")
                for f_path in corrupted_files:
                    report_file.write(f"{f_path}\n")
            print(f"\nA report of corrupted files has been saved to: {output_error_file}")
        else:
            print("\nAll JSON files in the directory are valid.")
