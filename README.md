# Artwork sharing backend

This independent Express service stores finished PNG artwork in MongoDB. Opening
an image URL returns the PNG itself, with no frontend or game connection required.
Images remain in MongoDB across application restarts; this service does not expire them.

## Local setup

Requires Node 20.19+ and a running MongoDB database (local MongoDB or Atlas).

```powershell
cd qr-to-image-hosted
npm ci
npm start
```

The local `.env` has a generated private upload key and a localhost MongoDB URI.
Set `MONGODB_URI` to your actual database connection string. `.env` is ignored by
Git; `.env.example` documents the variables. The process connects to MongoDB
before opening its HTTP port.

## Routes

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Returns 200 when MongoDB is connected, otherwise 503. |
| PUT | `/images/:id` | Upload raw PNG bytes; requires the private upload key. |
| GET | `/images/:id` | Return the matching PNG directly for QR scans. |
| GET | `/images/:id?download=true` | Return the PNG as a download attachment. |

Use the existing game's `artwork_id` as `:id`, or another random token of 16–128
letters, numbers, underscores, or hyphens. Never use player names as IDs. Uploads
accept `Content-Type: image/png`, up to 8 MB and dimensions up to 4096 × 4096.
Uploading the same ID replaces its PNG, so upload retries do not create duplicates.
The service checks the PNG header, dimensions, and end marker; it does not decode
or regenerate images. PNGs should come from the trusted game backend.

Upload from the game backend using the PNG returned by `ArtworkStore.render()`:

```python
import os
import urllib.request

def publish_artwork(artwork_id, png):
    url = f"{os.environ['ARTWORK_SHARE_URL'].rstrip('/')}/images/{artwork_id}"
    request = urllib.request.Request(
        url, data=png, method="PUT",
        headers={
            "Content-Type": "image/png",
            "Authorization": f"Bearer {os.environ['ARTWORK_SHARE_UPLOAD_KEY']}",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode()
```

After a successful upload, encode the returned `url` in the QR code:

```text
https://your-image-service.onrender.com/images/ARTWORK_ID
```

The game backend automatically renders and uploads completed artwork in a
background thread when hosted sharing is configured. Both player and leaderboard
QRs wait for that upload, then use its hosted `/images/:id` URL. Upload failures
are retried while the sharing panel is open and never block gameplay.
Before the first-round countdown of each match (including rematches), the game
backend also sends a background `/health` request to wake a sleeping image
service. Games start immediately without waiting for the request; simultaneous
games share an in-flight warm-up request.

In **the Python game backend's** `backend/.env`, set:

```dotenv
ARTWORK_SHARE_URL=https://your-image-service.onrender.com
ARTWORK_SHARE_UPLOAD_KEY=THE_SAME_VALUE_AS_THE_IMAGE_SERVICE_UPLOAD_API_KEY
```

Use the public origin only, without `/images` or a trailing path. On **the image
service**, set `PUBLIC_BASE_URL` to that same origin and `UPLOAD_API_KEY` to that
same private key. The local environment files already contain matching generated
keys. Restart both services after editing their environment settings. No new
frontend environment variable is needed: the game API supplies the published URL.

Leave `ARTWORK_SHARE_URL` blank to retain the existing local artwork-page QR flow.
The Python backend's optional `/artworks/:id/qr` endpoint uses the hosted URL too;
it returns 409 until upload finishes. Hosted PNG links keep working after the game
backend restarts; unuploaded images held only in its memory do not survive a restart.

## Render configuration

Create a **Web Service**, connect this repository, and use:

| Setting | Value |
|---|---|
| Runtime | Node |
| Root Directory | `qr-to-image-hosted` |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

Set these environment variables in Render:

```dotenv
NODE_VERSION=22
MONGODB_URI=mongodb+srv://YOUR_DATABASE_CONNECTION_STRING
PUBLIC_BASE_URL=https://your-image-service.onrender.com
UPLOAD_API_KEY=YOUR_PRIVATE_RANDOM_KEY_AT_LEAST_32_CHARACTERS
```

Render sets `PORT`. Configure Atlas network access to allow the service to connect.
Use the same upload key in the game backend. Keep it out of browser code and
`VITE_` variables. PNG downloads and QR navigation do not need CORS because they
open the image directly; the installed `cores` package is unrelated to CORS and
is not used here.

## Validation

```powershell
npm test
```

Tests exercise real HTTP requests with an in-memory storage adapter, plus the
Mongoose schema. A real MongoDB connection must also be checked when configuring
your database credentials and deploying.
