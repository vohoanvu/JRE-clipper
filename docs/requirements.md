# Requirements Document for "What would Joe Rogan say?" App

## 1. Project Overview

The "What would Joe Rogan say?" app enables users to input a topic and discover relevant discussions from Joe Rogan Experience (JRE) podcast episodes. The app searches all available JRE episodes, identifies relevant discussions by Joe Rogan or his guests, and presents the results through embedded YouTube players with clickable timestamp navigation. Users can watch specific segments directly in the browser without needing to download videos, providing a seamless and legal viewing experience that respects YouTube's terms of service.

## 2. Functional Requirements

- **User Interface (UI)**: Provide a web page featuring a text input form where users can enter a topic (e.g., "Jiu Jitsu", "Bees", "Aliens").
- **Topic Search**: Search a pre-indexed database containing vectorized transcripts segments and metadata from all JRE episodes to identify mentions or discussions of the user-specified topic.
- **Results Display**: Present search results as embedded YouTube players, one for each relevant episode, with the video title and episode information.
- **Timestamp Navigation**: Below each embedded player, display clickable timestamps where the topic is discussed, allowing users to jump directly to relevant segments.
- **Auto-seek Functionality**: Optionally, automatically seek to the first relevant segment when a video loads.
- **Episode Metadata**: Display episode titles, guest names, and brief context descriptions for each relevant segment.
- **Responsive Design**: Ensure the interface works well on desktop and mobile devices with proper YouTube embed responsiveness.

## 3. Non-Functional Requirements

- **Performance**: Efficiently search and display results from large volumes of transcript data.
- **Accuracy**: Accurately detect topics and display relevant segments with proper context.
- **Usability**: Provide intuitive timestamp navigation and seamless YouTube embed integration.
- **Responsiveness**: Deliver fast search results and smooth video playback experience.
- **Legal Compliance**: Fully comply with YouTube's terms of service by using official embed players instead of downloading content.
- **Accessibility**: Ensure proper keyboard navigation and screen reader compatibility for embedded videos and timestamps.

## 4. Dependencies and Constraints

- **YouTube Data API Integration**: Utilize the YouTube Data API to retrieve episode metadata and, if available, transcripts. (already done locally using Python scraper)
- **Transcript Generation**: Generate transcripts using speech-to-text services (e.g., Google Speech-to-Text, AWS Transcribe) when YouTube does not provide them. (already done locally using Python scraper)
- **Natural Language Processing (NLP)**: Employ NLP tools to analyze transcripts and accurately detect topic mentions or discussions. (integrate Vextex AI Search database for symantic search)
- **Video Processing**: Use tools like FFmpeg for extracting and editing video clips.
- **Database Storage**: Leverage a Vector Database from Google Cloud to store pre-indexed transcripts and metadata from all JRE episodes, enabling efficient similarity searches and retrieval.
- **Legal Compliance**: Comply with YouTube’s terms of service and copyright laws, potentially restricting usage to fair-use snippets or requiring user consent.


user_query_understanding_agent.json
jre_semantic_relevance_agent.json
jre_video_synthesis_agent.json
jre_timestamp_report_agent.json
clip-curation-agent.json

result-delivery-agent.json