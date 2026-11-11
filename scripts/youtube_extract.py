#!/usr/bin/env python3
"""
YouTube Extractor
Runs via GitHub Actions (workflow_dispatch) with a video URL.
Pulls the timestamped transcript (youtube-transcript-api) and metadata
(YouTube Data API v3 when YOUTUBE_API_KEY is set, otherwise yt-dlp), then
writes one JSON file per video plus a small index for the UI.

Output: data/youtube/<video_id>.json, data/youtube/index.json

Env:
  YOUTUBE_API_KEY  optional  official Data API v3 key (adds like/comment counts)
  YT_PROXY         optional  http(s) proxy URL — GitHub's runner IPs are often
                             blocked by YouTube, a residential proxy fixes that
  YT_LANGS         optional  comma-separated language preference (default "en")
"""

import json
import logging
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import YouTubeTranscriptApiException
from youtube_transcript_api.proxies import GenericProxyConfig

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "youtube"
INDEX_PATH = DATA_DIR / "index.json"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


# ── URL parsing ────────────────────────────────────────────────────────────────

def parse_video_id(raw: str) -> str:
    """Accept a bare 11-char ID or any common YouTube URL form."""
    raw = raw.strip()
    if ID_RE.match(raw):
        return raw
    u = urlparse(raw if "://" in raw else "https://" + raw)
    host = (u.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    vid = None
    if host == "youtu.be":
        vid = u.path.strip("/").split("/")[0]
    elif host in ("youtube.com", "music.youtube.com", "youtube-nocookie.com"):
        if u.path == "/watch":
            vid = parse_qs(u.query).get("v", [None])[0]
        else:
            m = re.match(r"^/(?:shorts|embed|live|v)/([^/?#]+)", u.path)
            vid = m.group(1) if m else None
    if not vid or not ID_RE.match(vid):
        raise ValueError(f"Could not find a YouTube video ID in: {raw!r}")
    return vid


# ── Metadata ───────────────────────────────────────────────────────────────────

def iso_duration_to_secs(iso: str) -> int:
    m = re.match(r"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$", iso or "")
    if not m:
        return 0
    h, mi, s = (int(x or 0) for x in m.groups())
    return h * 3600 + mi * 60 + s


def metadata_from_api(video_id: str, key: str) -> dict:
    r = requests.get(
        "https://www.googleapis.com/youtube/v3/videos",
        params={"part": "snippet,contentDetails,statistics", "id": video_id, "key": key},
        timeout=20,
    )
    r.raise_for_status()
    items = r.json().get("items") or []
    if not items:
        raise RuntimeError("Data API returned no video (private, deleted, or wrong ID)")
    it = items[0]
    sn, st, cd = it["snippet"], it.get("statistics", {}), it.get("contentDetails", {})
    num = lambda k: int(st[k]) if k in st else None  # noqa: E731
    return {
        "title": sn.get("title"),
        "channel": sn.get("channelTitle"),
        "channel_id": sn.get("channelId"),
        "published": sn.get("publishedAt"),
        "description": sn.get("description"),
        "tags": sn.get("tags", []),
        "duration_secs": iso_duration_to_secs(cd.get("duration", "")),
        "views": num("viewCount"),
        "likes": num("likeCount"),
        "comments": num("commentCount"),
        "chapters": [],
        "source": "youtube-data-api-v3",
    }


def metadata_from_ytdlp(video_id: str, proxy: str | None) -> dict:
    import yt_dlp

    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True}
    if proxy:
        opts["proxy"] = proxy
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    d = info.get("upload_date")  # YYYYMMDD
    published = f"{d[:4]}-{d[4:6]}-{d[6:]}" if d and len(d) == 8 else None
    return {
        "title": info.get("title"),
        "channel": info.get("channel") or info.get("uploader"),
        "channel_id": info.get("channel_id"),
        "published": published,
        "description": info.get("description"),
        "tags": info.get("tags") or [],
        "duration_secs": info.get("duration") or 0,
        "views": info.get("view_count"),
        "likes": info.get("like_count"),
        "comments": info.get("comment_count"),
        "chapters": [
            {"start": int(c.get("start_time", 0)), "title": c.get("title", "")}
            for c in (info.get("chapters") or [])
        ],
        "source": "yt-dlp",
    }


def metadata_from_oembed(video_id: str) -> dict:
    """Last resort — keyless, but only gives title + channel."""
    r = requests.get(
        "https://www.youtube.com/oembed",
        params={"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"},
        timeout=20,
    )
    r.raise_for_status()
    j = r.json()
    return {"title": j.get("title"), "channel": j.get("author_name"), "source": "oembed"}


def get_metadata(video_id: str, proxy: str | None) -> dict:
    """Data API → yt-dlp → oEmbed. Returns whatever the first working source gives."""
    errors = []
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    attempts = []
    if key:
        attempts.append(("YouTube Data API", lambda: metadata_from_api(video_id, key)))
    attempts.append(("yt-dlp", lambda: metadata_from_ytdlp(video_id, proxy)))
    attempts.append(("oEmbed", lambda: metadata_from_oembed(video_id)))
    for name, fn in attempts:
        try:
            md = fn()
            log.info("Metadata via %s", name)
            return md
        except Exception as e:  # noqa: BLE001 — fall through to the next source
            log.warning("%s failed: %s", name, str(e).splitlines()[0][:200])
            errors.append(f"{name}: {str(e).splitlines()[0][:200]}")
    return {"metadata_errors": errors}


# ── Transcript ─────────────────────────────────────────────────────────────────

def get_transcript(video_id: str, langs: list[str], proxy: str | None) -> dict:
    api = YouTubeTranscriptApi(
        proxy_config=GenericProxyConfig(http_url=proxy, https_url=proxy) if proxy else None
    )
    tlist = api.list(video_id)
    try:
        tr = tlist.find_transcript(langs)  # manual captions win over auto-generated
    except YouTubeTranscriptApiException:
        tr = next(iter(tlist))  # nothing in the preferred languages — take what exists
    fetched = tr.fetch()
    segments = [
        {"start": round(s["start"], 2), "duration": round(s["duration"], 2), "text": s["text"]}
        for s in fetched.to_raw_data()
    ]
    return {
        "language": tr.language,
        "language_code": tr.language_code,
        "is_generated": tr.is_generated,
        "segments": segments,
    }


# ── Output ─────────────────────────────────────────────────────────────────────

def update_index(entry: dict) -> None:
    items = []
    if INDEX_PATH.exists():
        items = json.loads(INDEX_PATH.read_text())
    items = [i for i in items if i["id"] != entry["id"]]
    items.insert(0, entry)  # newest first
    INDEX_PATH.write_text(json.dumps(items, indent=2, ensure_ascii=False) + "\n")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: youtube_extract.py <youtube-url-or-id>", file=sys.stderr)
        return 2
    video_id = parse_video_id(sys.argv[1])
    proxy = os.environ.get("YT_PROXY", "").strip() or None
    langs = [x.strip() for x in os.environ.get("YT_LANGS", "en").split(",") if x.strip()]
    log.info("Extracting %s", video_id)

    meta = get_metadata(video_id, proxy)
    transcript, transcript_error = None, None
    try:
        transcript = get_transcript(video_id, langs, proxy)
        log.info("Transcript: %d segments (%s%s)", len(transcript["segments"]),
                 transcript["language_code"], ", auto" if transcript["is_generated"] else "")
    except Exception as e:  # noqa: BLE001
        transcript_error = f"{type(e).__name__}: {str(e).strip().splitlines()[0][:300] if str(e).strip() else ''}"
        log.error("Transcript failed: %s", transcript_error)

    record = {
        "id": video_id,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "extracted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        **meta,
        "transcript": transcript,
        "transcript_error": transcript_error,
    }

    if not transcript and not meta.get("title"):
        log.error("Nothing could be extracted — not writing any files")
        return 1

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / f"{video_id}.json").write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
    update_index({
        "id": video_id,
        "title": meta.get("title") or video_id,
        "channel": meta.get("channel"),
        "published": meta.get("published"),
        "duration_secs": meta.get("duration_secs"),
        "has_transcript": transcript is not None,
        "extracted_at": record["extracted_at"],
    })
    log.info("Wrote data/youtube/%s.json", video_id)
    # Fail the run (red X in Actions) when the transcript — the main point — is missing
    return 0 if transcript else 1


if __name__ == "__main__":
    sys.exit(main())
