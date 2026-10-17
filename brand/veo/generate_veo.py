"""Generate and retrieve the GUDEX mascot clips with Vertex AI Veo.

Uses the existing gcloud login. Tokens stay in memory and are never saved.
Run `python generate_veo.py submit hello`, then `python generate_veo.py poll`.
`submit all` skips recorded requests, except a confirmed billing rejection.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone
from urllib import request, error

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "videos"
STATE = OUT / "generation.json"
PROJECT = "gudini-506711"
MODEL = "veo-3.1-fast-generate-001"
ENDPOINT = (
    "https://us-central1-aiplatform.googleapis.com/v1/"
    f"projects/{PROJECT}/locations/us-central1/publishers/google/models/{MODEL}"
)
PARAMETERS = {
    "sampleCount": 1,
    "durationSeconds": 4,
    "aspectRatio": "16:9",
    "resolution": "720p",
    "generateAudio": False,
    "enhancePrompt": False,
    "negativePrompt": (
        "camera movement, zoom, pan, added text, subtitles, extra characters, "
        "background change, shadows on background, lighting change"
    ),
}
COMMON = (
    " Static locked-off camera, the character stays centered and the same size, "
    "no camera movement. Solid flat chroma key green background, evenly lit, "
    "no shadows on the background, no other objects except the character's "
    "existing props and any explicitly requested confetti. Preserve the exact "
    "character design, clothes, existing G logo and existing prop lettering. "
    "Do not add text. The animation ends in exactly the same pose as it starts, "
    "so it can loop seamlessly."
)


def now():
    return datetime.now(timezone.utc).isoformat()


def save(state):
    OUT.mkdir(exist_ok=True)
    temp = STATE.with_suffix(".tmp")
    temp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    temp.replace(STATE)


def load():
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    return {"project": PROJECT, "model": MODEL, "parameters": PARAMETERS, "clips": {}}


def token():
    gcloud = Path(os.environ["LOCALAPPDATA"]) / "Google/Cloud SDK/google-cloud-sdk/bin/gcloud.ps1"
    result = subprocess.run(
        ["powershell", "-NoProfile", "-File", str(gcloud), "auth", "print-access-token"],
        capture_output=True, text=True, check=True,
    )
    tokens = [part for part in result.stdout.split() if part.startswith("ya29.")]
    if not tokens:
        raise RuntimeError("No Google OAuth access token returned by gcloud")
    return tokens[-1]


def api(method, payload, access_token):
    req = request.Request(
        ENDPOINT + ":" + method,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + access_token, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=90) as response:
            return json.load(response)
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from None


def prompts():
    text = (ROOT / "PROMPTS.md").read_text(encoding="utf-8")
    rows = re.findall(r"^\| `([a-z]+)\.png` \| [^|]+ \| (.+?) \|$", text, flags=re.M)
    return {name: prompt + COMMON for name, prompt in rows}


def submit(names, state, access_token):
    available = prompts()
    for name in names:
        if name not in available:
            raise ValueError(f"Unknown clip: {name}")
        prior = state["clips"].get(name)
        billing_rejected = (
            prior is not None
            and prior["status"] == "submission_error"
            and "HTTP 403" in str(prior.get("error", ""))
            and "BILLING_DISABLED" in str(prior.get("error", ""))
            and not prior.get("operation")
        )
        if prior is not None and not billing_rejected:
            print(f"{name}: already recorded ({state['clips'][name]['status']}), skipped", flush=True)
            continue
        image_bytes = (ROOT / f"{name}.png").read_bytes()
        frame = {"bytesBase64Encoded": base64.b64encode(image_bytes).decode("ascii"), "mimeType": "image/png"}
        clip = {
            "status": "submission_pending", "submitted_at": now(),
            "source_sha256": hashlib.sha256(image_bytes).hexdigest(),
            "prompt": available[name],
        }
        state["clips"][name] = clip
        save(state)
        try:
            response = api("predictLongRunning", {
                "instances": [{"prompt": available[name], "image": frame, "lastFrame": frame}],
                "parameters": PARAMETERS,
            }, access_token)
            if not response.get("name"):
                raise RuntimeError("Submission response did not contain an operation name")
            clip.update(status="running", operation=response["name"])
            save(state)
            print(f"{name}: submitted", flush=True)
        except Exception as exc:
            clip.update(status="submission_error", error=str(exc))
            save(state)
            print(f"{name}: {exc}", flush=True)
            return 1
    return 0


def poll(state, access_token):
    failures = 0
    for name, clip in state["clips"].items():
        if clip["status"] != "running":
            print(f"{name}: {clip['status']}", flush=True)
            continue
        try:
            result = api("fetchPredictOperation", {"operationName": clip["operation"]}, access_token)
            if not result.get("done"):
                print(f"{name}: running", flush=True)
                continue
            if result.get("error"):
                clip.update(status="failed", error=result["error"], completed_at=now())
                failures += 1
            else:
                response = result.get("response", {})
                videos = response.get("videos", [])
                if not videos:
                    clip.update(status="failed", error=response, completed_at=now())
                    failures += 1
                else:
                    video = videos[0]
                    encoded = video.get("bytesBase64Encoded")
                    if not encoded:
                        raise RuntimeError("Video response did not contain inline bytes: " + str(list(video)))
                    data = base64.b64decode(encoded, validate=True)
                    path = OUT / f"{name}.mp4"
                    if path.exists():
                        raise RuntimeError(f"Refusing to overwrite existing {path.name}")
                    path.write_bytes(data)
                    clip.update(
                        status="completed", completed_at=now(), file=path.name,
                        bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                        mime_type=video.get("mimeType"),
                    )
            save(state)
            print(f"{name}: {clip['status']}" + (f" ({clip.get('bytes', 0)} bytes)" if clip['status'] == "completed" else ""), flush=True)
            if clip.get("error"):
                print(json.dumps(clip["error"], ensure_ascii=False), flush=True)
        except Exception as exc:
            failures += 1
            print(f"{name}: poll error: {exc}", flush=True)
    return 1 if failures else 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["submit", "poll", "status"])
    parser.add_argument("clips", nargs="*")
    args = parser.parse_args()
    state = load()
    if args.action == "status":
        for name, clip in state["clips"].items():
            print(name, clip["status"])
        return 0
    access_token = token()
    if args.action == "submit":
        names = list(prompts()) if args.clips == ["all"] else args.clips
        if not names:
            parser.error("submit requires one or more clip names, or all")
        return submit(names, state, access_token)
    return poll(state, access_token)


if __name__ == "__main__":
    sys.exit(main())
