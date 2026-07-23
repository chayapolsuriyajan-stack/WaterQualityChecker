---
name: markitdown
description: Convert PDFs, Office docs (Word/PowerPoint/Excel), images, audio, HTML, CSV/JSON/XML, ZIPs, EPubs, or YouTube URLs into Markdown text. Use when the user gives a file/URL in one of these formats and wants its text content, a summary, or wants it turned into Markdown.
---

# markitdown

[microsoft/markitdown](https://github.com/microsoft/markitdown) — installed via `pip install 'markitdown[all]'` in this project's Python environment. Converts a wide range of document formats to Markdown so the content can be read/searched/summarized as plain text.

## When to use

The user supplies (or references) a file/URL in a supported format and wants its content extracted or turned into Markdown — e.g. "summarize this PDF", "what does this slide deck say", "pull the text out of this spreadsheet", "turn this Word doc into markdown".

## Supported formats

PDF, PowerPoint, Word, Excel, images (EXIF + OCR, or vision captioning with an LLM client), audio (transcription), HTML, CSV, JSON, XML, ZIP archives (converts contents), YouTube URLs, EPubs.

## CLI usage (fastest path)

```bash
markitdown path/to/file.pdf                  # prints Markdown to stdout
markitdown path/to/file.pdf -o out.md        # writes to a file
cat path/to/file.pdf | markitdown            # stdin also works
```

On Windows, if `markitdown` isn't on PATH, use `py -m markitdown ...` instead — same behavior. Expect a harmless `RuntimeWarning: Couldn't find ffmpeg` on stderr from the audio-transcription dependency (`pydub`) even when converting non-audio files; this doesn't affect non-audio conversions and can be ignored (only actual audio transcription needs `ffmpeg` on PATH).

## Python API

```python
from markitdown import MarkItDown

md = MarkItDown(enable_plugins=False)
result = md.convert("test.xlsx")
print(result.text_content)
```

For image captioning via an LLM instead of bare OCR/EXIF:
```python
from markitdown import MarkItDown
from openai import OpenAI

md = MarkItDown(llm_client=OpenAI(), llm_model="gpt-4o")
result = md.convert("example.jpg")
```

For Azure Document Intelligence-backed extraction (better tables/scans): pass `docintel_endpoint="<endpoint>"` to `MarkItDown(...)`.

## Notes

- `enable_plugins=True` (Python) / `--use-plugins` (CLI) turns on third-party converters if any are installed (`markitdown --list-plugins` to check what's registered).
- **Security**: markitdown performs I/O with the privileges of the current process (like `open()`/`requests.get()`) — it will fetch/read whatever the process can reach. Treat untrusted input files/URLs with the same caution as any other file read or network fetch.
- Verified working in this project (2026-07-23) by converting `web/index.html` to Markdown via `py -m markitdown` — image formats (e.g. `docs/dashboard.png`) return empty output without an `llm_client` configured, since there's no OCR-able text and no vision model to caption it.
