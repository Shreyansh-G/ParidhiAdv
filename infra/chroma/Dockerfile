# ChromaDB vector database for Paridhi — deployed on Cloud Run (scale-to-zero).
# Cloud Build builds this from source; Cloud Run can't pull Docker Hub directly.
FROM chromadb/chroma:latest

# Chroma listens on 8000; pass --port 8000 to `gcloud run deploy`.
EXPOSE 8000
