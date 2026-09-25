"""Audio media streaming and safe file delivery service for FastAPI backend."""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from pathlib import Path

import anyio
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

_RANGE_NOT_SATISFIABLE = {"error": "requested range not satisfiable"}


def parse_byte_range(range_header: str, total_size: int) -> tuple[int, int, str] | None:
    """Parse HTTP Range header into (start, end_exclusive, content_range_header).

    Returns None if the header is malformed, unsupported, or unsatisfiable.
    """
    if not range_header or total_size <= 0:
        return None
    range_header = range_header.strip()
    if not range_header.startswith("bytes="):
        return None
    spec = range_header[len("bytes="):].strip()
    if "," in spec:
        return None
    parts = spec.split("-", 1)
    if len(parts) != 2:
        return None
    raw_start, raw_end = parts[0].strip(), parts[1].strip()
    try:
        if raw_start and raw_end:
            start = int(raw_start)
            end = int(raw_end)
            if start < 0 or end < start or start >= total_size:
                return None
            end_exclusive = min(end + 1, total_size)
        elif raw_start and not raw_end:
            start = int(raw_start)
            if start < 0 or start >= total_size:
                return None
            end_exclusive = total_size
        elif not raw_start and raw_end:
            suffix_len = int(raw_end)
            if suffix_len <= 0:
                return None
            start = max(0, total_size - suffix_len)
            end_exclusive = total_size
        else:
            return None
    except ValueError:
        return None

    content_range = f"bytes {start}-{end_exclusive - 1}/{total_size}"
    return start, end_exclusive, content_range


def resolve_stored_path(storage_dir: Path, stored_filename: str) -> Path | None:
    """Resolve stored filename within storage_dir, rejecting any traversal."""
    base = storage_dir.resolve()
    candidate = (base / stored_filename).resolve()
    if candidate.parent != base:
        return None
    return candidate


def stream_media_file(
    request: Request,
    path: Path,
    content_type: str,
    stored_filename: str,
) -> Response:
    """Return full-content or partial-content (Range) streaming response for an audio file."""
    if not path.is_file():
        return JSONResponse({"error": "asset file missing"}, status_code=410)

    try:
        stat = os.stat(path)
    except OSError:
        return JSONResponse({"error": "asset file missing"}, status_code=410)

    total_size = stat.st_size

    range_header = request.headers.get("Range")

    # Range processing
    if range_header is not None and total_size > 0:
        parsed_range = parse_byte_range(range_header, total_size)
        if parsed_range is None:
            # Malformed range or unsupported format
            return _range_not_satisfiable(request, total_size)

        start, end_exclusive, content_range_header = parsed_range
        content_length = end_exclusive - start

        headers = {
            "Content-Disposition": f"inline; filename={stored_filename}",
            "Content-Type": content_type,
            "Content-Length": str(content_length),
            "Cache-Control": "no-cache",
            "Accept-Ranges": "bytes",
            "Content-Range": content_range_header,
        }

        if request.method == "HEAD":
            return Response(status_code=206, media_type=content_type, headers=headers)

        async def iter_range() -> AsyncGenerator[bytes, None]:
            bytes_to_read = content_length
            chunk_size = 65536
            async with await anyio.open_file(path, "rb") as fh:
                await fh.seek(start)
                while bytes_to_read > 0:
                    read_len = min(chunk_size, bytes_to_read)
                    chunk = await fh.read(read_len)
                    if not chunk:
                        break
                    bytes_to_read -= len(chunk)
                    yield chunk

        return StreamingResponse(
            iter_range(),
            status_code=206,
            media_type=content_type,
            headers=headers,
        )

    # Full content response (no Range header, or total_size == 0)
    headers = {
        "Content-Disposition": f"inline; filename={stored_filename}",
        "Content-Length": str(total_size),
        "Cache-Control": "no-cache",
        "Accept-Ranges": "bytes",
    }

    if request.method == "HEAD":
        return Response(status_code=200, media_type=content_type, headers=headers)

    async def iterfile() -> AsyncGenerator[bytes, None]:
        async with await anyio.open_file(path, "rb") as fh:
            while chunk := await fh.read(65536):
                yield chunk

    return StreamingResponse(
        iterfile(),
        media_type=content_type,
        headers=headers,
    )


def _range_not_satisfiable(request: Request, total_size: int) -> Response:
    headers = {"Content-Range": f"bytes */{total_size}"}
    return JSONResponse(_RANGE_NOT_SATISFIABLE, status_code=416, headers=headers)