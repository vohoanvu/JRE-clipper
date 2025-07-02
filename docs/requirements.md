# Requirements Document for "What would Joe Rogan say?" App

## 1. Project Overview

The "What would Joe Rogan say?" app enables users to input a topic and discover relevant discussions from Joe Rogan Experience (JRE) podcast episodes. The app searches all available JRE episodes, identifies relevant discussions by Joe Rogan or his guests, and presents the results through embedded YouTube players with clickable timestamp navigation. Users can watch specific segments directly in the browser without needing to download videos, providing a seamless and legal viewing experience that respects YouTube's terms of service. Premium subscribers can generate custom video compilations of relevant segments across multiple episodes.

## 2. Functional Requirements

### Core Features (Free for All Users)
- **User Interface (UI)**: Provide a web page featuring a text input form where users can enter a topic (e.g., "Jiu Jitsu", "Bees", "Aliens").
- **Unlimited Topic Search**: Search a pre-indexed database containing vectorized transcripts segments and metadata from all JRE episodes to identify mentions or discussions of the user-specified topic, with no search limits.
- **Results Display**: Present search results as embedded YouTube players, one for each relevant episode, with the video title and episode information.
- **Timestamp Navigation**: Below each embedded player, display clickable timestamps where the topic is discussed, allowing users to jump directly to relevant segments.
- **Auto-seek Functionality**: Automatically seek to the first relevant segment when a video loads.
- **Episode Metadata**: Display episode titles, guest names, and brief context descriptions for each relevant segment.
- **Responsive Design**: Ensure the interface works well on desktop and mobile devices with proper YouTube embed responsiveness.
- **Manual Compilation Requests**: Allow non-authenticated users to request custom video compilations via email.

### Premium Features (Requires Authentication + Subscription)
- **Video Compilation Generation**: Create custom compilations of relevant segments across multiple episodes into a single downloadable video.
- **Custom Compilation Settings**: Allow users to select specific segments to include, adjust padding time, and set playback order.
- **High-Quality Processing**: Process video compilations with high-quality audio/video synchronization using FFmpeg.
- **Download Access**: Provide secure, time-limited download links to compiled videos.
- **Processing Status Tracking**: Real-time tracking of video compilation progress.

## 3. Non-Functional Requirements

- **Performance**: Efficiently search and display results from large volumes of transcript data.
- **Accuracy**: Accurately detect topics and display relevant segments with proper context.
- **Usability**: Provide intuitive timestamp navigation and seamless YouTube embed integration.
- **Responsiveness**: Deliver fast search results and smooth video playback experience.
- **Legal Compliance**: Fully comply with YouTube's terms of service by using official embed players for free tier users, while providing fair-use video compilations for premium subscribers.
- **Accessibility**: Ensure proper keyboard navigation and screen reader compatibility for embedded videos and timestamps.
- **Security**: Implement Firebase Authentication for secure user access to premium features.
- **Reliability**: Ensure stable video processing with error recovery mechanisms and detailed logging.
- **Scalability**: Support growing user base with efficient cloud resource utilization.

## 4. Dependencies and Constraints

- **YouTube Data API Integration**: Utilize the YouTube Data API to retrieve episode metadata. (implemented using Python scraper)
- **Transcript Processing**: Process transcripts scraped from 3rd party transcription service without needing speech-to-text generation.
- **Vector Embeddings**: Convert transcript segments into vector embeddings for semantic search capabilities. (implemented with Vertex AI embedding services)
- **Video Processing**: Use FFmpeg for extracting and editing video clips with precise audio/video synchronization.
- **Database Storage**: Use Vector Database (implemented with Vertex AI) to store pre-indexed transcripts and metadata from all JRE episodes, enabling efficient similarity searches and retrieval.
- **Authentication & Payment**: Firebase Authentication and Stripe integration for user accounts and premium subscriptions.
- **Cloud Infrastructure**: Google Cloud Platform components including Cloud Run, Cloud Storage, Pub/Sub, and Firestore.
- **Legal Compliance**: Comply with YouTube's terms of service and copyright laws, restricting usage to fair-use snippets and requiring user authentication for premium features.*Legal Compliance**: Comply with YouTube's terms of service and copyright laws, restricting usage to fair-use snippets and requiring user authentication for premium features.
- **Authentication & Payment**: Firebase Authentication and Stripe integration for user accounts and premium subscriptions.
- **Cloud Infrastructure**: Google Cloud Platform components including Cloud Run, Cloud Storage, Pub/Sub, and Firestore.ogan say?" App


## 5. System Architecture Components

### Frontend Components
- **Search Interface**: Main user interface for topic searching
- **Results Display**: Component for showing search results with embedded YouTube players
- **Authentication System**: Firebase Auth integration for user login/signup
- **Subscription Management**: Interface for managing premium subscriptions through Stripe
- **Video Request Form**: Interface for requesting video compilations
- **Status Tracking**: Component for monitoring video compilation progress

### Backend Services
- **Search Service**: Handles semantic search queries against the vector database
- **Video Processing Service**: Cloud Run service for segment extraction and compilation
- **Authentication Service**: Firebase Auth service for user management
- **Payment Processing**: Stripe integration for handling subscriptions
- **Job Management**: System for tracking and reporting video processing status