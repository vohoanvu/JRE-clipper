import json
import os

def transform_to_discovery_engine_schema(input_ndjson_path, output_ndjson_path):
    """
    Transforms an NDJSON file to conform to the Google Cloud Discovery Engine Document schema,
    embedding textual content in 'content.rawText' for data stores with CONTENT_REQUIRED.
    The 'content.uri' will store the original URL as a reference.
    This format is intended for use with data_schema="document" during import.

    Args:
        input_ndjson_path (str): Path to the input NDJSON file.
        output_ndjson_path (str): Path to the output NDJSON file.
    """
    print(f"Starting transformation of {input_ndjson_path} for Discovery Engine (embedding content for CONTENT_REQUIRED data stores)...")
    transformed_count = 0
    error_count = 0

    output_dir = os.path.dirname(output_ndjson_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)
        print(f"Created output directory: {output_dir}")

    with open(input_ndjson_path, 'r', encoding='utf-8') as infile, \
         open(output_ndjson_path, 'w', encoding='utf-8') as outfile:
        for line_number, line in enumerate(infile, 1):
            try:
                original_doc = json.loads(line.strip())
                
                doc_id = original_doc.get("videoId")
                if not doc_id:
                    print(f"Warning: Missing 'videoId' (and thus 'id') in line {line_number}. Skipping document: {line.strip()}")
                    error_count +=1
                    continue

                title = original_doc.get("title", "")
                description = original_doc.get("description", "")
                doc_uri = original_doc.get("Url") 

                # content.uri is required by the previous error, so we ensure it exists.
                # If it's just a reference URL (like a YouTube link) and not a GCS path for fetching,
                # it's fine when content is embedded via rawText.
                if not doc_uri:
                    print(f"Warning: Missing 'Url' (for content.uri) in line {line_number} for videoId {doc_id}. Skipping document as URI was previously indicated as required.")
                    error_count +=1
                    continue
                
                # Prepare the textual content for embedding
                embedded_text_content = f"{title}. {description}".strip()

                # Prepare the payload for the top-level structData field
                # This holds additional metadata, not the primary searchable content if it's in rawText.
                top_level_struct_data = {
                    "original_videoId": doc_id, # Retain for reference if needed
                    "publish_date": original_doc.get("date"),
                    # title and description are now primarily in content.rawText
                    # but can be kept here for faceting/filtering if desired.
                    "filter_title": title,
                    "filter_description_snippet": description[:200], # Example: snippet for filtering
                    "youtube_url_reference": doc_uri, # Explicitly naming it as reference
                    "is_transcripted": original_doc.get("isTranscripted"),
                    "is_vectorized": original_doc.get("isVectorized"),
                    "is_empty_transcript": original_doc.get("isEmptyTranscript")
                }
                
                top_level_struct_data = {k: v for k, v in top_level_struct_data.items() if v is not None}
                
                transformed_doc = {
                    "id": doc_id,
                    "structData": top_level_struct_data, 
                    "content": {
                        "uri": doc_uri, # Reference URI
                        "rawText": embedded_text_content, # Embedded textual content
                        "mimeType": "text/plain" # Specify the MIME type for rawText
                    }
                }
                
                outfile.write(json.dumps(transformed_doc) + '\n')
                transformed_count += 1
            except json.JSONDecodeError as e:
                print(f"Error decoding JSON on line {line_number}: {e}. Line: {line.strip()}")
                error_count += 1
            except Exception as e:
                print(f"An unexpected error occurred on line {line_number}: {e}. Line: {line.strip()}")
                error_count += 1

    print(f"\nTransformation complete.")
    print(f"Successfully transformed documents: {transformed_count}")
    print(f"Documents with errors/skipped: {error_count}")
    print(f"Output written to: {output_ndjson_path}")
    print(f"\nIMPORTANT: This output format is designed for data stores with CONTENT_REQUIRED.")
    print(f"Ensure your `ImportDocumentsRequest` uses `data_schema=\"document\"`.")

if __name__ == "__main__":
    input_file = "/Users/vohoanvu/dev-repository/JRE-clipper/jre-playlist_cleaned.ndjson"
    output_file = "/Users/vohoanvu/dev-repository/JRE-clipper/jre-playlist_for_discovery_engine.ndjson"

    if not os.path.exists(input_file):
        print(f"Error: Input file not found: {input_file}")
    else:
        transform_to_discovery_engine_schema(input_file, output_file)
