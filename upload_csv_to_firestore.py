import csv
import json
from google.cloud import firestore

def csv_to_firestore(csv_file_path, collection_name, database_name):
    """Convert CSV to Firestore collection"""
    
    # Initialize Firestore client with specific database
    db = firestore.Client(database=database_name)
    collection_ref = db.collection(collection_name)
    
    with open(csv_file_path, 'r', encoding='utf-8') as file:
        csv_reader = csv.DictReader(file)
        batch = db.batch()
        count = 0
        
        for row in csv_reader:
            # Convert string booleans to actual booleans
            row['isTranscripted'] = row['isTranscripted'].lower() == 'true'
            row['isVectorized'] = row['isVectorized'].lower() == 'true'
            row['isEmptyTranscript'] = row['isEmptyTranscript'].lower() == 'true'
            
            # Use videoId as document ID
            doc_ref = collection_ref.document(row['videoId'])
            batch.set(doc_ref, row)
            
            count += 1
            
            # Commit batch every 500 documents (Firestore limit)
            if count % 500 == 0:
                batch.commit()
                batch = db.batch()
                print(f"Uploaded {count} documents...")
        
        # Commit remaining documents
        if count % 500 != 0:
            batch.commit()
        
        print(f"Successfully uploaded {count} documents to {collection_name}")

if __name__ == "__main__":
    csv_to_firestore("./jre-playlist_cleaned.csv", "jre-episodes", "jre-clipper-db")