# Project Status: "What would Joe Rogan say?" - Backend Service

**Project Lead:** [Your Name/Lead Engineer's Name]
**Date:** `2024-07-26`
**Overall Status:** `On Track`

---

## 1. Implementation Phases

This section tracks the development progress of individual technical components as defined in the architectural plan.

| Phase                                | Description                                                                                                                                                            | Status                 | Notes / Blockers                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| **Phase 1: Setup & Foundation**      | Create solution, projects, project references, and install initial NuGet packages. Define core data models and service interfaces (`IVector...`, `IEmbedding...`, etc.). | `[x] Completed`      | All models and interfaces defined.                                               |
| **Phase 2: Infrastructure Services** | Implement concrete services for external systems. This includes `GoogleCloudStorageService`, `MockEmbeddingService`, `GoogleVertexAiEmbeddingService`, and the selected Vector DB services (`Qdrant`, `VertexAI`). | `[x] Completed`      | Implemented GCS, Vertex AI Embedding, Mock Embedding, Vertex AI Vector DB.       |
| **Phase 3: Core Business Logic**     | Implement the `BasicTranscriptProcessor` for chunking and the `VectorizationOrchestratorService` to coordinate the ingestion and search workflows.                   | `[x] In Progress`      | `BasicTranscriptProcessor` implemented. `VectorizationOrchestratorService` pending. |
| **Phase 4: Asynchronous Ingestion**  | Implement the Pub/Sub publisher in the API and create the background worker service (as a separate Cloud Run instance) to consume messages and run the ingestion process. | `[ ] Not Started`      | Requires Pub/Sub topic to be created in GCP.                                     |
| **Phase 5: API Endpoints & DI**      | Build the `IngestionController` and `SearchController`. Wire up all services using Dependency Injection, including the provider factories for embeddings and vector DBs. | `[x] In Progress`      | DI for core services configured in `Program.cs`. Controllers pending.          |
| **Phase 6: Containerization & Config** | Create the `Dockerfile` for the API service and the worker service. Finalize `appsettings.json` with configurations for all environments (Dev, Staging, Prod). | `[x] In Progress`      | `appsettings.json` and `appsettings.Development.json` populated. Dockerfiles pending. |

---

## 2. Milestone Checklist

This checklist tracks high-level, feature-complete deliverables that provide business value.

| Milestone                                                  | Requirement Addressed                                          | Status      | Validation Notes                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| **M1: Data Source Integration Complete**                   | Can read metadata and transcript files from Google Cloud Storage. | `[ ]`       | Verified by running the ingestion process and confirming files are downloaded and parsed correctly.  |
| **M2: Initial Data Ingestion Pipeline Operational**        | Can process and vectorize a batch of 10+ JRE episodes into a Vector DB. | `[ ]`       | Vector DB dashboard shows points have been upserted with correct metadata.                         |
| **M3: Core Search Functionality Live**                     | The `GET /api/search/videos` endpoint returns relevant segments for a query. | `[ ]`       | A query for "aliens" returns segments containing text about aliens, UFOs, etc.                 |
| **M4: Asynchronous Ingestion Trigger is Functional**       | `POST /api/ingestion/start` successfully queues a job via Pub/Sub. | `[ ]`       | Endpoint returns `202 Accepted`. GCP console shows a message published to the topic.               |
| **M5: Pluggable Architecture is Verified**                 | Can switch between `Qdrant` and `VertexAI` via a configuration change. | `[x]`       | Embedding service factory and DI setup allows for selection via config. Vector DB pending. |
| **M6: Full Dataset Ingested into Staging**                 | All available JRE transcripts are processed and available for search in the staging environment. | `[ ]`       | A search for an obscure topic returns at least one relevant result.                                |

---

## 3. Testing Criteria

This section outlines the specific tests required to ensure quality and correctness.

| Test Category                   | Description                                                                                                                                              | Status            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **Unit Tests**                  | - `BasicTranscriptProcessor` correctly chunks text based on time.<br>- Models correctly deserialize from sample JSON/CSV.                               | `[ ] Not Covered` |
| **Integration Tests (Ingestion)** | - `VectorizationOrchestratorService` can successfully execute a full flow: GCS download -> Process -> Embed (mocked) -> Upsert to Vector DB (local). | `[ ] Not Covered` |
| **Integration Tests (Search)**    | - `SearchController` can successfully execute a full flow: Query -> Embed (mocked) -> Search Vector DB (local) -> Return formatted results.          | `[ ] Not Covered` |
| **System Tests (E2E)**          | - `POST` to ingestion API triggers the background worker, which fully processes a file from GCS into the staging Vector DB.<br>- `GET` from search API returns data from the staging Vector DB. | `[ ] Not Covered` |
| **Configuration Tests**         | - The application starts successfully with each configured provider (`Qdrant`, `VertexAI`).<br>- The application fails gracefully with an invalid provider name. | `[x]`             | DI and Options configured.                                                               |
| **Performance Tests**           | - Search API response time is < 2 seconds under a simulated load of 20 concurrent users.                                                                 | `[ ] Not Covered` |

---

## 4. Deployment Stages

This outlines the path from local development to a live production environment.

| Stage                   | Description                                                                                                                                                                                                                                     | Status                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Stage 1: Local Development**  | Developer runs services on their local machine. Uses local secrets, .NET Hot Reload, and Docker Desktop for Qdrant.                                                                                                                        | `[x] Ready`            |
| **Stage 2: CI/CD Pipeline**     | A `cloudbuild.yaml` file is committed. Pushing to the `main` branch automatically builds, tests, and pushes Docker images for the API and worker services to Google Artifact Registry.                                                  | `[ ] Not Started`      |
| **Stage 3: Staging Deployment** | A Cloud Build trigger deploys the images from Artifact Registry to a dedicated "staging" Cloud Run environment. This environment uses a separate staging GCS bucket, Pub/Sub topic, and Vector DB index. Used for final E2E testing and UAT. | `[ ] Not Started`      |
| **Stage 4: Production Deployment**| Upon manual approval, a Cloud Build trigger deploys the tested images to the "production" Cloud Run environment. All secrets are managed by Google Secret Manager. Monitoring and alerting are active. Traffic is shifted gradually. | `[ ] Not Started`      |