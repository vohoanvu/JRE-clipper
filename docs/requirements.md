# Requirements Document for "What would Joe Rogan say?" App

## 1. Project Overview

The "What would Joe Rogan say?" app enables users to input a topic and receive a summary video and timestamp report of Joe Rogan Experience (JRE) podcast episodes where the topic is discussed. The app searches all available JRE episodes on YouTube, identifies relevant discussions by Joe Rogan or his guests, extracts clips from these discussions, compiles them into a single summary video, and generates a timestamp report listing episode details and specific times where the topic is mentioned. The summary video and report are then made available for users to download.

## 2. Functional Requirements

- **User Interface (UI)**: Provide a web page featuring a text input form where users can enter a topic (e.g., "Jiu Jitsu", "Bees", "Aliens").
- **Topic Search**: Search a pre-indexed database containing vectorized transcripts segments and metadata from all JRE episodes to identify mentions or discussions of the user-specified topic.
- **Clip Selection**: Select and rank relevant clips based on their relevance to the topic and the duration of the discussion.
- **Video Generation**: Extract selected clips from their respective episodes and compile them into a single summary video, potentially including enhancements such as audio normalization or transitions.
- **Report Generation**: Produce a timestamp report including:
  - JRE episode numbers or titles.
  - Specific timestamps where the topic is discussed.
  - Optional brief descriptions of the context for each clip.
- **Delivery**: Store the summary video and timestamp report in the cloud and provide users with download links for both.

## 3. Non-Functional Requirements

- **Performance**: Efficiently process large volumes of data due to the extensive library of JRE episodes.
- **Accuracy**: Accurately detect topics and select clips to ensure relevance and contextual appropriateness.
- **Scalability**: Support multiple simultaneous user requests without performance degradation.
- **Responsiveness**: Deliver a user-friendly experience with timely feedback and progress indicators during processing.

## 4. Dependencies and Constraints

- **YouTube Data API Integration**: Utilize the YouTube Data API to retrieve episode metadata and, if available, transcripts. (already done locally using Python scraper)
- **Transcript Generation**: Generate transcripts using speech-to-text services (e.g., Google Speech-to-Text, AWS Transcribe) when YouTube does not provide them. (already done locally using Python scraper)
- **Natural Language Processing (NLP)**: Employ NLP tools to analyze transcripts and accurately detect topic mentions or discussions. (integrate Vector database for Similarity Search integration)
- **Video Processing**: Use tools like FFmpeg for extracting and editing video clips.
- **Database Storage**: Leverage a Vector Database from Google Cloud to store pre-indexed transcripts and metadata from all JRE episodes, enabling efficient similarity searches and retrieval.
- **Legal Compliance**: Comply with YouTube’s terms of service and copyright laws, potentially restricting usage to fair-use snippets or requiring user consent.


user_query_understanding_agent.json
jre_semantic_relevance_agent.json
jre_video_synthesis_agent.json
jre_timestamp_report_agent.json
clip-curation-agent.json

result-delivery-agent.json