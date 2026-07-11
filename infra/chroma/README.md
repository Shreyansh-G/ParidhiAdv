# Running ChromaDB on Cloud Run

Chroma is the vector database behind semantic search and the Civic Assistant's retrieval. It runs on
Cloud Run with `min-instances 0`, which means it shuts down completely when nobody's using it. Idle
cost is nothing, and light use stays inside the Cloud Run free tier.

## Deploying it, once

```bash
# Pick a strong access token. Chroma does its own auth with this.
export CHROMA_TOKEN="$(openssl rand -hex 24)"   # save it somewhere

# A bucket so the vectors survive a restart
gcloud storage buckets create gs://paridhi-chroma-data --location=asia-south1

# Deploy. Cloud Build builds the Dockerfile in this folder.
gcloud run deploy paridhi-chroma \
  --source infra/chroma \
  --region asia-south1 \
  --port 8000 \
  --memory 1Gi \
  --min-instances 0 --max-instances 1 \
  --execution-environment gen2 \
  --allow-unauthenticated \
  --add-volume name=chroma-data,type=cloud-storage,bucket=paridhi-chroma-data \
  --add-volume-mount volume=chroma-data,mount-path=/data \
  --set-env-vars "IS_PERSISTENT=TRUE,PERSIST_DIRECTORY=/data,CHROMA_SERVER_AUTHN_PROVIDER=chromadb.auth.token_authn.TokenAuthenticationServerProvider,CHROMA_SERVER_AUTHN_CREDENTIALS=${CHROMA_TOKEN}"
```

It'll print a service URL, something like `https://paridhi-chroma-xxxx.a.run.app`. Keep it.

A note on `--allow-unauthenticated`: the service is reachable from the network, but Chroma's own auth
gates it — every request has to carry `Authorization: Bearer $CHROMA_TOKEN`. If you want to tighten
that later, drop the flag and switch the callers to IAM ID tokens instead.

## Wiring it up

```bash
# The functions need the token as a secret
firebase functions:secrets:set CHROMA_TOKEN

# The URL isn't secret, so it's a plain env var
echo "CHROMA_URL=https://paridhi-chroma-xxxx.a.run.app" >> functions/.env
```

Then seed the vectors. Do this after every dataset refresh:

```bash
CHROMA_URL=https://paridhi-chroma-xxxx.a.run.app CHROMA_TOKEN=... npm run seed:chroma
```

The script upserts one vector per project *and* deletes any vector whose project no longer exists.
That second half matters: `upsert` on its own never removes anything, so a project that disappears
from OpenStreetMap would keep its vector forever, and semantic search would happily return an ID the
app can no longer resolve — silently returning fewer results than it claims to. The script finishes
by comparing the vector count against the dataset and exits with an error if they disagree.

For the weekly GitHub Action to reseed automatically, add `CHROMA_URL` and `CHROMA_TOKEN` as
repository secrets. Without them the workflow skips the reseed and prints a warning, which is how the
index quietly went stale the first time.

## Why it's built this way

**The embeddings are free.** Chroma's default model (all-MiniLM-L6-v2, running as ONNX) embeds both
documents and queries *inside* the server. There's no embedding API and no tokens to pay for.

**Retrieval and generation are separate jobs.** Chroma answers "which projects match this query".
The language model only turns the answer into a sentence. Keeping those apart is what keeps the AI
spend near zero.

**Cold starts are fine here.** Scaling to zero means the first request after an idle period takes
5–10 seconds. That's acceptable for a search feature, especially since the app always has instant
substring search as a fallback while it waits.
