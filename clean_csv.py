'''
Script to clean a CSV file for BigQuery upload, focusing on escaping double quotes
and removing newline characters within fields.
'''
import csv
import os

# Define the input and output file paths
# Assuming the script is in the same directory as jre-playlist.csv
input_csv_file = os.path.join(os.path.dirname(__file__), "jre-playlist.csv")
output_csv_file = os.path.join(os.path.dirname(__file__), "jre-playlist_cleaned.csv")

def clean_value(value):
    '''Cleans a string value by escaping double quotes and removing newlines.'''
    if value is None:
        return ""
    # Replace standalone double quotes with two double quotes (CSV standard for escaping)
    cleaned_value = value.replace('"', '""')
    # Replace newline characters with a space
    cleaned_value = cleaned_value.replace('\n', ' ').replace('\r', ' ')
    return cleaned_value

try:
    with open(input_csv_file, 'r', encoding='utf-8', newline='') as infile, \
         open(output_csv_file, 'w', encoding='utf-8', newline='') as outfile:

        reader = csv.reader(infile)
        writer = csv.writer(outfile, quoting=csv.QUOTE_ALL) # Quote all fields to be safe

        header = next(reader) # Read the header
        writer.writerow(header)

        # Assuming 'title' is the 2nd column (index 1) and 'description' is the 3rd column (index 2)
        # Adjust indices if your CSV structure is different.
        # From the jre-playlist.csv sample: videoId,title,description,date,Url,isTranscripted,isVectorized,isEmptyTranscript
        # title_col_index = 1
        # description_col_index = 2

        # Let's find column indices by name for robustness
        try:
            title_col_index = header.index("title")
            description_col_index = header.index("description")
        except ValueError as e:
            print(f"Error: Column not found in header - {e}")
            print("Please ensure 'title' and 'description' columns exist in your CSV.")
            exit(1)

        cleaned_rows = 0
        for row_number, row in enumerate(reader, start=2): # start=2 because header is row 1
            try:
                if len(row) > max(title_col_index, description_col_index):
                    row[title_col_index] = clean_value(row[title_col_index])
                    row[description_col_index] = clean_value(row[description_col_index])
                    writer.writerow(row)
                    cleaned_rows += 1
                else:
                    print(f"Warning: Row {row_number} has fewer columns than expected. Skipping problematic field cleaning for this row, writing as is if possible.")
                    # Attempt to write the row as is, or handle as an error
                    writer.writerow(row) # This might still cause issues if the row is malformed

            except Exception as e:
                print(f"Error processing row {row_number}: {row}")
                print(f"Exception: {e}")
                # Optionally, write problematic rows to a separate error file or skip them
                # For now, we'll try to write the original row if cleaning fails for some reason
                # but this is unlikely given the clean_value function.

    print(f"Successfully processed {cleaned_rows + 1} rows (including header).") # +1 for header
    print(f"Cleaned data written to: {output_csv_file}")

except FileNotFoundError:
    print(f"Error: The input file '{input_csv_file}' was not found.")
except Exception as e:
    print(f"An unexpected error occurred: {e}")

