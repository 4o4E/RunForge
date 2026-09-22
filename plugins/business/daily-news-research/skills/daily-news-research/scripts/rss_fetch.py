#!/usr/bin/env python3
import email.utils
import html
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

def rss_entries(root):
    result = []
    for node in root.findall(".//item"):
        result.append({
            "title": text(node, "title"),
            "url": text(node, "link"),
            "summary": text(node, "description") or text(node, "{http://purl.org/rss/1.0/modules/content/}encoded"),
            "published": text(node, "pubDate") or text(node, "{http://purl.org/dc/elements/1.1/}date"),
        })
    atom = "{http://www.w3.org/2005/Atom}"
    for node in root.findall(f".//{atom}entry"):
        link = next((item.get("href", "") for item in node.findall(f"{atom}link") if item.get("rel", "alternate") == "alternate"), "")
        result.append({
            "title": text(node, f"{atom}title"),
            "url": link,
            "summary": text(node, f"{atom}content") or text(node, f"{atom}summary"),
            "published": text(node, f"{atom}published") or text(node, f"{atom}updated"),
        })
    return result

def text(node, path):
    value = node.find(path)
    return "" if value is None else "".join(value.itertext()).strip()

def parse_time(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        parsed = email.utils.parsedate_to_datetime(value)
        return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).astimezone(timezone.utc)

def clean_text(value):
    without_tags = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(without_tags)).strip()

def main():
    source_path, output_path, since_text = sys.argv[1:4]
    since = datetime.fromisoformat(since_text.replace("Z", "+00:00")).astimezone(timezone.utc)
    sources = json.loads(Path(source_path).read_text(encoding="utf-8"))
    items = []
    errors = []
    for source in sources:
        name = str(source["name"]).strip()
        url = str(source["url"]).strip()
        if urlparse(url).scheme not in ("http", "https"):
            raise ValueError(f"RSS URL 只支持 HTTP/HTTPS: {url}")
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "RunForge RSS/1.0"})
            with urllib.request.urlopen(request, timeout=30) as response:
                root = ET.fromstring(response.read(10 * 1024 * 1024))
            for entry in rss_entries(root):
                published = parse_time(entry["published"])
                if published and published < since:
                    continue
                items.append({
                    "source": name,
                    "feedUrl": url,
                    "title": entry["title"],
                    "url": entry["url"],
                    "summary": clean_text(entry["summary"])[:4000],
                    "publishedAt": published.isoformat().replace("+00:00", "Z") if published else None,
                })
        except Exception as error:
            errors.append({"source": name, "url": url, "error": f"{type(error).__name__}: {error}"})

    seen = set()
    deduplicated = []
    for item in items:
        key = item["url"] or item["title"].casefold()
        if not key or key in seen:
            continue
        seen.add(key)
        deduplicated.append(item)
    Path(output_path).write_text(json.dumps({"since": since.isoformat(), "items": deduplicated, "errors": errors}, ensure_ascii=False), encoding="utf-8")
    print(str(Path(output_path).resolve()))

if __name__ == "__main__":
    main()
